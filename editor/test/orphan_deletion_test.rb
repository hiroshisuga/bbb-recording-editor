# frozen_string_literal: true
require 'minitest/autorun'
require 'minitest/mock'
require 'tmpdir'
require_relative '../server'

class OrphanDeletionTest < Minitest::Test
  def setup
    @dir = Dir.mktmpdir('orphan-delete-')
    @id = "#{'a' * 40}-1700000000000"
    @roots = { 'recording_dir' => "#{@dir}/recording", 'raw_presentation_src' => @dir,
               'published_dir' => "#{@dir}/published", 'raw_audio_src' => "#{@dir}/audio", 'log_dir' => "#{@dir}/logs" }
    @repo = RecordingEditor::Repository.new(raw_root: "#{@dir}/recording/raw", state_root: "#{@dir}/state",
      published_root: "#{@dir}/published/presentation", unpublished_root: "#{@dir}/unpublished/presentation")
    @raw = File.join(@repo.raw_root, @id)
    FileUtils.mkdir_p(@raw)
    File.write(File.join(@raw, 'leftover.txt'), 'leftover')
    @service = RecordingEditor::OrphanDeletion.new(@repo)
    # A checkout's fixture is owned by the test runner, not root. Fake only that
    # ownership bit; production mode, digest, path and inventory checks still run.
    @service.define_singleton_method(:configuration) do
      original_stat = File.method(:stat)
      File.stub(:stat, lambda { |path|
        stat = original_stat.call(path)
        stat.define_singleton_method(:uid) { 0 } if path == RecordingEditor::OrphanDeletion::COMMAND
        stat
      }) { super() }
    end
    @saved_constants = {}
    script = "#{@dir}/bbb-record"
    block = File.read(File.join(__dir__, 'fixtures/bbb-record-delete-block.txt'))
    setup = File.read(File.join(__dir__, 'fixtures/bbb-record-setup.txt'))
    File.write(script, "declare -r BBB_YML=#{setup}readonly TYPES\nif [ $DELETE ]; then\n#{block}\nif [ $DELETEALL ]; then\nfi\n")
    File.chmod(0o755, script)
    config = "#{@dir}/bigbluebutton.yml"
    File.write(config, YAML.dump(@roots))
    workflows = "#{@dir}/workflows"
    FileUtils.mkdir_p(workflows)
    File.write("#{workflows}/presentation.rb", '')
    props = "#{@dir}/bbb-web.properties"
    File.write(props, "securitySalt=test-only-secret\nbigbluebutton.web.serverURL=https://bbb.example.test\n")
    { COMMAND: script, CONFIG: config, WORKFLOWS: workflows, PROPERTIES: [props] }.each do |key, value|
      @saved_constants[key] = RecordingEditor::OrphanDeletion.const_get(key)
      RecordingEditor::OrphanDeletion.send(:remove_const, key)
      RecordingEditor::OrphanDeletion.const_set(key, value)
    end
  end

  def teardown
    @saved_constants.each do |key, value|
      RecordingEditor::OrphanDeletion.send(:remove_const, key)
      RecordingEditor::OrphanDeletion.const_set(key, value)
    end
    FileUtils.remove_entry(@dir)
  end

  def inactive
    @service.stub(:ensure_not_live, nil) { yield }
  end

  def test_plan_is_read_only_and_includes_prefix_variants_and_hidden_files
    FileUtils.mkdir_p("#{@raw}-extra")
    File.write("#{@raw}/.hidden", '123')
    File.write("#{@raw}-extra/a", '45')
    FileUtils.mkdir_p("#{@dir}/recording/status/archived")
    File.write("#{@dir}/recording/status/archived/#{@id}.done", '')
    inactive do
      a = @service.plan(@id)
      assert_equal 4, a[:file_count]
      assert_equal 13, a[:bytes]
      assert_includes a[:entries].map { |e| e[:path] }, "#{@raw}/.hidden"
      assert_equal File.join(@repo.state_root, @id), a[:retained]
      assert_equal a, @service.plan(@id)
      assert File.file?("#{@raw}/leftover.txt")
    end
  end

  def test_changed_inventory_and_unconfirmed_requests_never_execute
    inactive do
      plan = @service.plan(@id)
      File.write("#{@raw}/new", 'new')
      Open3.stub(:capture3, ->(*) { flunk 'Deletion must not execute' }) do
        assert_raises(RecordingEditor::Error) { @service.delete(@id, {}) }
        e = assert_raises(RecordingEditor::Error) { @service.delete(@id, { 'confirmed' => true, 'meeting_id' => @id, 'revision' => plan[:revision] }) }
        assert_equal 409, e.status
      end
    end
  end

  def test_every_other_recording_format_and_processing_output_blocks_deletion
    %w[published/video unpublished/other deleted/video recording/process/video recording/publish/video].each do |prefix|
      path = File.join(@dir, prefix, @id)
      FileUtils.mkdir_p(path)
      inactive { assert_raises(RecordingEditor::Error, prefix) { @service.plan(@id) } }
      FileUtils.rm_rf(path)
    end
  end

  def test_related_xml_symlinks_and_configuration_changes_block_deletion
    inactive do
      File.write("#{@raw}/events.xml", 'broken XML')
      assert_raises(RecordingEditor::Error) { @service.plan(@id) }
      File.unlink("#{@raw}/events.xml")
      File.symlink('/etc/passwd', "#{@raw}/unsafe")
      assert_raises(RecordingEditor::Error) { @service.plan(@id) }
      File.unlink("#{@raw}/unsafe")
      File.open(RecordingEditor::OrphanDeletion::COMMAND, 'a') { |f| f.write('') }
      File.write(RecordingEditor::OrphanDeletion::COMMAND, 'unknown script')
      assert_raises(RecordingEditor::Error) { @service.plan(@id) }
    end
  end

  def test_delegates_only_to_bbb_and_preserves_editor_backups
    FileUtils.mkdir_p(File.join(@repo.state_root, @id))
    backup = File.join(@repo.state_root, @id, 'original')
    File.write(backup, 'original')
    inactive do
      plan = @service.plan(@id)
      command = lambda do |env, *args, **options|
        assert_equal [RecordingEditor::OrphanDeletion::COMMAND, '--delete', @id], args
        assert options[:unsetenv_others]
        assert_equal '/', options[:chdir]
        refute env.key?('RUBYOPT')
        assert_equal Etc.getpwuid(Process.euid).name, env['USER']
        FileUtils.remove_entry(@raw) # Only the fake BBB command removes fixture data.
        ['', '', Struct.new(:success?).new(true)]
      end
      Open3.stub(:capture3, command) do
        assert @service.delete(@id, { 'confirmed' => true, 'meeting_id' => @id, 'revision' => plan[:revision] })[:deleted]
      end
      assert_equal 'original', File.read(backup)
    end
  end

  def test_success_exit_with_remaining_files_is_reported_as_failure_without_fallback
    inactive do
      plan = @service.plan(@id)
      Open3.stub(:capture3, ['', '', Struct.new(:success?).new(true)]) do
        e = assert_raises(RecordingEditor::Error) { @service.delete(@id, { 'confirmed' => true, 'meeting_id' => @id, 'revision' => plan[:revision] }) }
        assert_equal 422, e.status
      end
      assert File.file?("#{@raw}/leftover.txt")
    end
  end

  def test_active_bbb_meetings_and_api_failures_are_blocked
    response = Net::HTTPOK.new('1.1', '200', 'OK')
    xml = "<response><returncode>SUCCESS</returncode><meetings><meeting><internalMeetingID>#{@id}</internalMeetingID></meeting></meetings></response>"
    response.define_singleton_method(:body) { xml }
    http = Object.new
    http.define_singleton_method(:get) { |_path| response }
    Net::HTTP.stub(:start, ->(*_args, **_kwargs, &block) { block.call(http) }) do
      e = assert_raises(RecordingEditor::Error) { @service.plan(@id) }
      assert_equal 409, e.status
    end
    Net::HTTP.stub(:start, ->(*) { raise Timeout::Error }) do
      e = assert_raises(RecordingEditor::Error) { @service.plan(@id) }
      assert_equal 503, e.status
      refute_includes e.message, 'secret'
    end
  end
  def test_unreadable_directories_do_not_silently_disappear_from_review
    children = Dir.method(:children)
    inactive do
      Dir.stub(:children, ->(path) { raise Errno::EACCES if path == @raw; children.call(path) }) do
        e = assert_raises(RecordingEditor::Error) { @service.plan(@id) }
        assert_equal 503, e.status
      end
    end
  end

  def test_bbb4_yq_go_setup_is_supported_and_path_mismatch_is_rejected
    script = RecordingEditor::OrphanDeletion::COMMAND
    File.write(script, File.read(script).gsub('yq e', 'yq-go e'))
    inactive { assert @service.plan(@id)[:revision] }
    config = RecordingEditor::OrphanDeletion::CONFIG
    File.write(config, YAML.dump(@roots.merge('recording_dir' => @dir + '/other')))
    inactive { assert_raises(RecordingEditor::Error) { @service.plan(@id) } }
  end

end
