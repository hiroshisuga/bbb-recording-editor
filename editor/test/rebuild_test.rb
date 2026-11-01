# frozen_string_literal: true
require 'minitest/autorun'
require 'tmpdir'
require_relative '../server'
require_relative '../deploy/00_recording_editor_title'

class RebuildTest < Minitest::Test
  def setup
    @dir = Dir.mktmpdir('bbb-rebuild-')
    @id = "#{'a' * 40}-1700000000000"
    @repo = RecordingEditor::Repository.new(raw_root: File.join(@dir, 'raw'), state_root: File.join(@dir, 'state'),
      published_root: File.join(@dir, 'published'), unpublished_root: File.join(@dir, 'unpublished'))
    FileUtils.mkdir_p(File.join(@repo.raw_root, @id))
    @xml = '<recording><event timestamp="1000" eventname="RecordStatusEvent"><status>true</status></event><event timestamp="5000" eventname="RecordStatusEvent"><status>false</status></event></recording>'
    File.write(File.join(@repo.raw_root, @id, 'events.xml'), @xml)
    @repo.define_singleton_method(:rebuild_info) { |id| super(id).merge('available' => true) }
    @editor = RecordingEditor::Editor.new(@repo)
    @payload = { 'confirmed' => true, 'revision' => Digest::SHA256.hexdigest(@xml) }
  end

  def teardown
    FileUtils.remove_entry(@dir)
  end

  def rebuild(status: true, error: '')
    runner = lambda do |*args|
      assert_equal ['/usr/bin/sudo', '-n', RecordingEditor::Repository::REBUILD_HELPER, @id, @payload['revision']], args
      ['', error, Struct.new(:success?).new(status)]
    end
    Open3.stub(:capture3, runner) { @editor.rebuild(@id, @payload) }
  end

  def marker(step, suffix, seconds = 1)
    name = step == 'sanity' ? "#{@id}.#{suffix}" : "#{@id}-presentation.#{suffix}"
    path = File.join(@repo.status_root, step, name)
    FileUtils.mkdir_p(File.dirname(path))
    File.write(path, '')
    time = Time.now + seconds
    File.utime(time, time, path)
    path
  end

  def test_rebuild_only_enqueues_saved_revision_and_does_not_change_raw
    result = rebuild
    assert_equal 'requested', result['status']
    assert_equal @xml, File.read(File.join(@repo.raw_root, @id, 'events.xml'))
    assert_equal @payload['revision'], result['revision']
    assert_equal 'requested', @repo.rebuild_info(@id)['status']
  end

  def test_title_is_captured_before_deletion_and_restored_before_publishing
    published = File.join(@repo.published_root, @id, 'metadata.xml')
    FileUtils.mkdir_p(File.dirname(published))
    File.write(published, '<recording><state>published</state><published>true</published><meta><name>Renamed &amp; recorded</name></meta></recording>')
    request_id = nil
    runner = lambda do |*args|
      snapshot = JSON.parse(File.read(File.join(@repo.state_dir(@id), 'rebuild-request.json')))
      assert_equal 'Renamed & recorded', snapshot['recording_title']
      request_id = snapshot['request_id']
      assert_match(/\A[0-9a-f]{32}\z/, request_id)
      FileUtils.rm_rf(File.dirname(published))
      assert_equal 'Renamed & recorded', @repo.recording(@id).to_h[:name]
      assert_equal 'Renamed & recorded', @repo.list.find { |r| r[:id] == @id }[:name]
      generated = File.join(@repo.process_root, @id, 'metadata.xml')
      FileUtils.mkdir_p(File.dirname(generated))
      File.write(generated, '<recording><state>processed</state><meta><meetingName>Original room</meetingName></meta></recording>')
      restorer = RecordingEditorTitle::Restore.new(raw_root: @repo.raw_root, state_root: @repo.state_root, process_root: @repo.process_root)
      assert_equal :restored, restorer.call(@id, 'presentation')
      FileUtils.mkdir_p(File.dirname(published))
      FileUtils.cp(generated, published)
      ['', '', Struct.new(:success?).new(true)]
    end
    result = Open3.stub(:capture3, runner) { @editor.rebuild(@id, @payload) }
    assert_equal request_id, result['request_id']
    assert_equal 'restored', result['title_restore']
    marker('published', 'done')
    assert_equal 'completed', @repo.rebuild_info(@id)['status']
    assert_equal 'restored', @repo.rebuild_info(@id)['title_restore']
    assert_equal 'Renamed & recorded', @repo.recording(@id).to_h[:name]
    assert_equal @xml, File.read(File.join(@repo.raw_root, @id, 'events.xml'))
  end

  def test_failed_rebuild_retry_keeps_the_snapshot_when_generated_recording_has_been_removed
    info = { 'status' => 'failed', 'revision' => @payload['revision'], 'request_id' => '1' * 32,
             'requested_at' => (Time.now - 10).utc.iso8601(6), 'recording_title' => 'Title before failure' }
    @repo.write_rebuild_info(@id, info)
    assert_equal 'Title before failure', @repo.recording(@id).to_h[:name]
    result = rebuild
    assert_equal 'Title before failure', result['recording_title']
    refute_equal info['request_id'], result['request_id']
  end

  def test_missing_or_failed_title_receipt_is_reported_separately_from_successful_media_rebuild
    result = rebuild
    info = JSON.parse(File.read(File.join(@repo.state_dir(@id), 'rebuild-request.json')))
    info['recording_title'] = 'Expected title'
    @repo.write_rebuild_info(@id, info)
    marker('published', 'done')
    assert_equal 'completed', @repo.rebuild_info(@id)['status']
    assert_equal 'failed', @repo.rebuild_info(@id)['title_restore']
    receipt = File.join(@repo.state_dir(@id), 'title-restore-presentation.json')
    File.write(receipt, JSON.generate('request_id' => 'old', 'status' => 'restored'))
    assert_equal 'failed', @repo.rebuild_info(@id)['title_restore']
    File.write(receipt, JSON.generate('request_id' => result['request_id'], 'status' => 'restored'))
    assert_equal 'restored', @repo.rebuild_info(@id)['title_restore']
  end

  def test_manifest_distinguishes_raw_save_reset_and_matching_completed_rebuild
    assert_equal 'unknown', @repo.recording(@id).to_h[:playback_sync]
    rec = @repo.recording(@id)
    @editor.save(@id, { 'revision' => rec.revision, 'record_ranges' => [{ 'start_ms' => 500, 'end_ms' => 3500 }], 'beep_ranges' => [] })
    assert_equal 'needs_rebuild', @repo.recording(@id).to_h[:playback_sync]
    @payload['revision'] = @repo.recording(@id).revision
    rebuild
    marker('published', 'done')
    assert_equal 'reflected', @repo.recording(@id).to_h[:playback_sync]
    @editor.reset(@id, @payload)
    data = @repo.recording(@id).to_h
    assert_equal 'needs_rebuild', data[:playback_sync]
    assert_equal 'reset', data[:last_operation]
    assert data[:record_ranges_persisted]
    @payload['revision'] = @repo.recording(@id).revision
    # A stale completion for the same revision must not clear a newer reset.
    @repo.write_rebuild_info(@id, { 'status' => 'completed', 'revision' => @payload['revision'], 'requested_at' => (Time.now - 5).utc.iso8601(6) })
    assert_equal 'needs_rebuild', @repo.recording(@id).to_h[:playback_sync]
    rebuild
    marker('published', 'done')
    assert_equal 'reflected', @repo.recording(@id).to_h[:playback_sync]
  end

  def test_manifest_reports_empty_recording_ranges_and_processing_separately
    xml = '<recording><event timestamp="1000" eventname="ParticipantJoinEvent"/><event timestamp="5000" eventname="EndAndKickAllEvent"/></recording>'
    File.write(File.join(@repo.raw_root, @id, 'events.xml'), xml)
    data = @repo.recording(@id).to_h
    refute data[:record_ranges_persisted]
    assert_empty data[:record_ranges]
    dir = File.join(@repo.process_root, @id)
    FileUtils.mkdir_p(dir)
    File.write(File.join(dir, 'metadata.xml'), '<recording><state>processing</state></recording>')
    assert @repo.rebuild_info(@id)['processing']
  end

  def test_confirmation_and_current_revision_are_required_before_execution
    @payload['confirmed'] = false
    assert_raises(RecordingEditor::Error) { @editor.rebuild(@id, @payload) }
    @payload['confirmed'] = true
    @payload['revision'] = 'stale'
    assert_equal 409, assert_raises(RecordingEditor::Error) { @editor.rebuild(@id, @payload) }.status
    refute File.file?(File.join(@repo.state_dir(@id), 'rebuild-request.json'))
  end

  def test_unmarked_raw_cannot_be_rebuilt_without_saving_recording_ranges
    xml = '<recording><event timestamp="1000" eventname="ParticipantJoinEvent"/><event timestamp="5000" eventname="EndAndKickAllEvent"/></recording>'
    File.write(File.join(@repo.raw_root, @id, 'events.xml'), xml)
    @payload['revision'] = Digest::SHA256.hexdigest(xml)
    assert_raises(RecordingEditor::Error) { @editor.rebuild(@id, @payload) }
  end

  def test_pending_rebuild_blocks_another_request_and_raw_save
    rebuild
    assert_equal 409, assert_raises(RecordingEditor::Error) { @editor.rebuild(@id, @payload) }.status
    assert_equal 409, assert_raises(RecordingEditor::Error) { @editor.save(@id, @payload) }.status
    assert_equal 409, assert_raises(RecordingEditor::Error) { @editor.reset(@id, @payload) }.status
    assert_equal @xml, File.read(File.join(@repo.raw_root, @id, 'events.xml'))
  end

  def test_only_fresh_completion_markers_finish_a_rebuild_and_terminal_state_is_persistent
    marker('published', 'done', -10)
    rebuild
    assert_equal 'requested', @repo.rebuild_info(@id)['status']
    path = marker('published', 'done')
    assert_equal 'completed', @repo.rebuild_info(@id)['status']
    File.unlink(path)
    assert_equal 'completed', @repo.rebuild_info(@id)['status']
  end

  def test_sanity_and_processing_failures_are_reported
    %w[sanity processed published].each do |step|
      FileUtils.rm_rf(File.join(@repo.state_dir(@id)))
      FileUtils.rm_rf(@repo.status_root)
      rebuild
      marker(step, 'fail')
      assert_equal 'failed', @repo.rebuild_info(@id)['status']
    end
  end

  def test_failed_submission_retains_failure_state_and_details
    error = assert_raises(RecordingEditor::Error) { rebuild(status: false, error: 'sudo: no new privileges') }
    assert_equal 422, error.status
    assert_includes error.message, 'no new privileges'
    assert_equal 'command_failed', @repo.rebuild_info(@id)['status']
  end

  def test_rebuild_availability_requires_both_title_hooks_as_well_as_the_existing_helper
    hooks = [RecordingEditor::Repository::TITLE_RESTORE_HOOK, RecordingEditor::Repository::TITLE_FINALIZE_HOOK]
    original_file = File.method(:file?)
    installed = []
    File.stub(:executable?, true) do
      File.stub(:file?, ->(path) { hooks.include?(path) ? installed.include?(path) : original_file.call(path) }) do
        refute @repo.read_rebuild_info(@id)['available']
        installed << hooks.first
        refute @repo.read_rebuild_info(@id)['available']
        installed << hooks.last
        assert @repo.read_rebuild_info(@id)['available']
      end
    end
  end

  def test_missing_helper_reports_setup_error_without_creating_request
    @repo.define_singleton_method(:rebuild_info) { |id| super(id).merge('available' => false) }
    assert_equal 503, assert_raises(RecordingEditor::Error) { @editor.rebuild(@id, @payload) }.status
    refute File.file?(File.join(@repo.state_dir(@id), 'rebuild-request.json'))
  end

  def test_already_processing_recording_is_not_modified
    path = File.join(@repo.process_root, @id, 'metadata.xml')
    FileUtils.mkdir_p(File.dirname(path))
    File.write(path, '<recording><state>processing</state></recording>')
    assert_equal 409, assert_raises(RecordingEditor::Error) { @editor.rebuild(@id, @payload) }.status
    assert_equal 409, assert_raises(RecordingEditor::Error) { @editor.save(@id, @payload) }.status
    assert_equal 409, assert_raises(RecordingEditor::Error) { @editor.reset(@id, @payload) }.status
  end

  def test_queue_rejects_concurrent_mutations_and_releases_key_after_failure
    jobs = RecordingEditor::Jobs.new
    gate = Queue.new
    started = Queue.new
    job = jobs.add('rebuild', key: @id) { started << true; gate.pop; raise RecordingEditor::Error, 'test failure' }
    started.pop
    assert_equal 409, assert_raises(RecordingEditor::Error) { jobs.add('save', key: @id) { nil } }.status
    gate << true
    100.times do
      break if jobs.get(job[:id])[:status] == 'failed'
      sleep 0.01
    end
    assert_equal 'failed', jobs.get(job[:id])[:status]
    assert jobs.add('save', key: @id) { nil }
  ensure
    gate << true if gate
    jobs.instance_variable_get(:@worker).kill if jobs
  end
end
