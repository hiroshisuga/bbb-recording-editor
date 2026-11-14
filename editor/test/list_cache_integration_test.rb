# frozen_string_literal: true
require 'minitest/autorun'
require 'minitest/mock'
require 'tmpdir'
require_relative '../lib/recording_editor'

class ListCacheIntegrationTest < Minitest::Test
  def setup
    @dir = Dir.mktmpdir('bbb-list-cache-')
    @id = "#{'a' * 40}-1700000000000"
    @options = { raw_root: "#{@dir}/raw", state_root: "#{@dir}/state", published_root: "#{@dir}/published",
                 unpublished_root: "#{@dir}/unpublished", process_root: "#{@dir}/process", status_root: "#{@dir}/status" }
    @repo = RecordingEditor::Repository.new(**@options)
    @cache = @repo.instance_variable_get(:@list_cache)
    @xml = "<recording><metadata meetingName='Room A'/><event timestamp='1000' eventname='RecordStatusEvent'><status>true</status></event><event timestamp='9000' eventname='RecordStatusEvent'><status>false</status></event><event timestamp='11000' eventname='EndAndKickAllEvent'/></recording>"
  end

  def teardown
    FileUtils.remove_entry(@dir)
  end

  def write(path, data)
    FileUtils.mkdir_p(File.dirname(path))
    File.write(path, data)
    path
  end

  def raw(id = @id)
    write(File.join(@repo.raw_root, id, 'events.xml'), @xml)
  end

  def metadata(root = @repo.unpublished_root, id = @id, name: 'Title A', state: 'unpublished')
    write(File.join(root, id, 'metadata.xml'), "<recording><state>#{state}</state><published>#{state == 'published'}</published><meta><name>#{name}</name></meta></recording>")
  end

  def item
    @repo.list.find { |row| row[:id] == @id }
  end

  def assert_no_xml_reads
    RecordingEditor.stub(:xml, ->(*) { flunk 'Unchanged XML was parsed again' }) { yield }
  end

  def test_warm_list_reads_no_xml_and_returns_independent_rows
    raw
    metadata
    expected = @repo.list
    assert_equal 2, @cache.size
    File.stub(:binread, ->(*) { flunk 'Warm list read XML bytes' }) do
      Digest::SHA256.stub(:hexdigest, ->(*) { flunk 'Warm list hashed XML bytes' }) do
        assert_equal expected, @repo.list
      end
    end
    result = @repo.list.first
    result[:name].replace('Corrupted')
    result[:meeting_name].replace('Corrupted')
    result[:warnings] << 'Injected'
    assert_equal expected, @repo.list
  end

  def test_only_changed_inputs_reparse_even_with_same_size_and_preserved_mtime
    events, meta = raw, metadata
    item
    [events, meta].each do |path|
      original = File.stat(path)
      bytes = File.binread(path)
      File.write(path, bytes.sub(' A', ' B'))
      File.utime(original.atime, original.mtime, path)
      reads, binread = [], File.method(:binread)
      File.stub(:binread, ->(file, *args) { reads << file; binread.call(file, *args) }) do
        row = item
        assert_equal 'Room B', row[:meeting_name]
        assert_equal(path == meta ? 'Title B' : 'Title A', row[:name])
      end
      assert_equal [path], reads
      assert_no_xml_reads { item }
    end
    original = File.stat(events)
    replacement = write(events + '.new', File.binread(events).sub('Room B', 'Room C'))
    File.utime(original.atime, original.mtime, replacement)
    File.rename(replacement, events)
    assert_equal 'Room C', item[:meeting_name]
  end

  def test_saved_history_and_original_events_are_cache_dependencies
    path = raw
    assert_equal 8000, item[:recorded_duration_ms]
    baseline = write(File.join(@repo.state_dir(@id), 'original-events.xml'), @xml.sub('Room A', 'Baseline'))
    history = { 'revision' => Digest::SHA256.file(path).hexdigest,
                'record_ranges' => [{ 'start_ms' => 500, 'end_ms' => 1500 }], 'effective_record_ranges' => [] }
    saved = write(File.join(@repo.state_dir(@id), 'saved.json'), JSON.generate(history))
    assert_equal 'Baseline', item[:meeting_name]
    assert_equal 1000, item[:recorded_duration_ms]
    File.write(baseline, File.binread(baseline).sub('Baseline', 'Original').sub('11000', '13000'))
    assert_equal 'Original', item[:meeting_name]
    assert_equal 12000, item[:duration_ms]
    history['record_ranges'][0]['end_ms'] = 2500
    File.write(saved, JSON.generate(history))
    assert_equal 2000, item[:recorded_duration_ms]
    File.unlink(saved)
    assert_equal 'Room A', item[:meeting_name]
    assert_equal 8000, item[:recorded_duration_ms]
    assert_equal 10000, item[:duration_ms]
  end

  def test_missing_invalid_and_unreadable_inputs_are_retried
    events, meta = raw, metadata
    item
    original_stat = File.method(:stat)
    File.stub(:stat, ->(path, *args) { raise Errno::EACCES if [events, meta].include?(path); original_stat.call(path, *args) }) do
      row = item
      refute row[:raw_available]
      assert_equal 'unknown', row[:generation_status]
      assert row[:warnings].any? { |message| message.include?('確認できません') || message.include?('読み込めません') }
    end
    assert item[:raw_available]
    assert_equal 'Title A', item[:name]
    File.write(events, 'invalid XML')
    File.write(meta, 'invalid XML')
    refute item[:raw_available]
    assert_equal 0, @cache.size
    raw
    metadata
    assert item[:raw_available]
    File.unlink(meta)
    assert_equal 'Room A', item[:name]
    File.unlink(events)
    refute item[:raw_available]
    assert_equal 0, @cache.size
  end

  def test_warm_cache_cannot_bypass_symlink_containment_checks
    events, meta = raw, metadata
    item
    [[events, @xml], [meta, '<recording><state>published</state></recording>']].each_with_index do |(path, bytes), i|
      outside = write("#{@dir}/outside-#{i}.xml", bytes)
      File.unlink(path)
      File.symlink(outside, path)
      row = item
      i.zero? ? refute(row[:raw_available]) : assert_equal('unknown', row[:generation_status])
      File.unlink(path)
      i.zero? ? raw : metadata
      assert item[:raw_available]
    end
  end

  def test_raw_presence_and_publication_locations_are_always_fresh
    path = metadata
    nested = File.join(@repo.raw_root, @id, 'audio', 'nested')
    FileUtils.mkdir_p(nested)
    assert_equal 'missing', item[:raw_data_status]
    write(File.join(nested, 'mic.webm'), 'media')
    assert_equal 'present', item[:raw_data_status]
    FileUtils.rm_rf(File.dirname(path))
    metadata(@repo.published_root, state: 'published')
    assert_equal 'published', item[:publication_status]
    FileUtils.mkdir_p(File.join(@repo.unpublished_root, @id))
    assert_equal 'unknown', item[:publication_status]
    assert item[:warnings].any? { |warning| warning.include?('両方') }
  end

  def test_processing_failures_and_rebuild_completion_do_not_wait_for_cache_expiry
    raw
    metadata(@repo.process_root, state: 'processing')
    assert_equal 'processing', item[:generation_status]
    failure = write(File.join(@repo.status_root, 'processed', "#{@id}-presentation.fail"), '')
    assert_no_xml_reads { assert_equal 'unknown', item[:generation_status] }
    File.unlink(failure)
    assert_no_xml_reads { assert_equal 'processing', item[:generation_status] }
    FileUtils.rm_rf(File.join(@repo.process_root, @id))
    metadata
    @repo.write_rebuild_info(@id, { 'status' => 'requested', 'requested_at' => (Time.now - 5).iso8601 })
    assert_equal 'processing', item[:generation_status]
    write(File.join(@repo.status_root, 'published', "#{@id}-presentation.done"), '')
    assert_no_xml_reads { assert_equal 'unpublished', item[:publication_status] }
    assert_equal 'completed', @repo.rebuild_info(@id)['status']
    @repo.write_rebuild_info(@id, { 'status' => 'command_failed' })
    assert_no_xml_reads { assert_equal 'unknown', item[:publication_status] }
  end

  def test_save_reset_and_explicit_bypass_use_current_files
    raw
    metadata
    item
    editor = RecordingEditor::Editor.new(@repo)
    saved = editor.save(@id, { 'revision' => @repo.recording(@id).revision,
      'record_ranges' => [{ 'start_ms' => 500, 'end_ms' => 9500 }], 'beep_ranges' => [] })
    assert_equal 0, @cache.size
    assert_equal 9000, item[:recorded_duration_ms]
    editor.reset(@id, { 'revision' => saved['revision'], 'confirmed' => true })
    assert_equal 0, @cache.size
    assert_equal 8000, item[:recorded_duration_ms]
    assert_equal @repo.list, @repo.list(cache: false)
    reads, parser = 0, RecordingEditor.method(:xml)
    RecordingEditor.stub(:xml, ->(*args) { reads += 1; parser.call(*args) }) do
      @repo.list(cache: false)
      assert_operator reads, :>=, 2
      reads = 0
      @repo.recording(@id)
      assert_operator reads, :>=, 1 # Detail/edit reads never use the list cache.
    end
  end

  def test_full_scans_keep_more_than_256_meetings_and_prune_deleted_ones
    ids = Array.new(300) { |i| "#{format('%040x', i + 1)}-1700000000000" }
    ids.each { |id| raw(id) }
    expected = @repo.list
    assert_equal 300, @cache.size
    assert_no_xml_reads { assert_equal expected, @repo.list }
    FileUtils.rm_rf(File.join(@repo.raw_root, ids.first))
    assert_no_xml_reads { assert_equal 299, @repo.list.size }
    assert_equal 299, @cache.size
    restarted = RecordingEditor::Repository.new(**@options)
    assert_equal 0, restarted.instance_variable_get(:@list_cache).size
    assert_equal @repo.list, restarted.list
  end
end
