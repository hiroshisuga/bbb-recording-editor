# frozen_string_literal: true
require 'minitest/autorun'
require 'tmpdir'
require_relative '../deploy/00_recording_editor_title'

class TitleRestoreTest < Minitest::Test
  def setup
    @dir = Dir.mktmpdir('bbb-title-')
    @id = "#{'a' * 40}-1700000000000"
    @raw = File.join(@dir, 'raw')
    @state = File.join(@dir, 'state')
    @process = File.join(@dir, 'process', 'presentation')
    [@raw, @state, @process].each { |root| FileUtils.mkdir_p(File.join(root, @id)) }
    @xml = '<recording><metadata meetingName="Room"/></recording>'
    File.write(File.join(@raw, @id, 'events.xml'), @xml)
    @title = '講義 <A> & "Part 1"'
    @request = { 'status' => 'requested', 'request_id' => '1' * 32, 'recording_title' => @title,
                 'revision' => Digest::SHA256.hexdigest(@xml), 'requested_at' => Time.now.utc.iso8601(6) }
    @request_path = File.join(@state, @id, 'rebuild-request.json')
    @metadata = File.join(@process, @id, 'metadata.xml')
    @initial = '<recording><state>processed</state><published>false</published><meta><meetingName>Room</meetingName><name>Old title</name><gl-listed>true</gl-listed></meta><playback><duration>10</duration></playback></recording>'
    write_request
    File.write(@metadata, @initial)
    File.chmod(0o640, @metadata)
    @restore = RecordingEditorTitle::Restore.new(raw_root: @raw, state_root: @state, process_root: @process)
  end

  def teardown
    FileUtils.remove_entry(@dir)
  end

  def write_request
    File.write(@request_path, JSON.generate(@request))
  end

  def marker(format = 'presentation')
    JSON.parse(File.read(File.join(@state, @id, "title-restore-#{format}.json")))
  end

  def test_restores_only_the_title_with_xml_escaping_and_preserves_raw_and_permissions
    assert_equal :restored, @restore.call(@id, 'presentation')
    doc = Nokogiri::XML(File.read(@metadata))
    assert_equal @title, doc.at_xpath('/recording/meta/name').text
    assert_equal 'Room', doc.at_xpath('/recording/meta/meetingName').text
    assert_equal 'true', doc.at_xpath('/recording/meta/gl-listed').text
    assert_equal 'false', doc.at_xpath('/recording/published').text
    assert_equal '10', doc.at_xpath('/recording/playback/duration').text
    assert_equal 0o640, File.stat(@metadata).mode & 0o777
    assert_equal @xml, File.read(File.join(@raw, @id, 'events.xml'))
    assert_equal @request['request_id'], marker['request_id']
    assert_equal 'restored', marker['status']
  end

  def test_consumes_once_per_request_and_format_and_does_not_replay_after_later_external_rebuilds
    @restore.call(@id, 'presentation')
    assert_equal :published, @restore.published(@id, 'presentation')
    File.write(@metadata, @initial.sub('Old title', 'Renamed later'))
    @request['status'] = 'completed'
    write_request
    assert_equal :already_restored, @restore.call(@id, 'presentation')
    assert_includes File.read(@metadata), 'Renamed later'
    # Other formats may finish after presentation; they have independent receipts.
    video = File.join(@dir, 'process', 'video', @id)
    FileUtils.mkdir_p(video)
    File.write(File.join(video, 'metadata.xml'), @initial)
    assert_equal :restored, @restore.call(@id, 'video')
    assert_equal 'restored', marker('video')['status']
    @request.merge!('status' => 'requested', 'request_id' => '2' * 32, 'recording_title' => 'New request title', 'requested_at' => Time.now.utc.iso8601(6))
    write_request
    File.write(@metadata, @initial)
    assert_equal :restored, @restore.call(@id, 'presentation')
    assert_equal 'New request title', Nokogiri::XML(File.read(@metadata)).at_xpath('/recording/meta/name').text
    assert_equal '2' * 32, marker['request_id']
  end

  def test_regenerated_metadata_can_retry_until_publication_then_is_consumed_without_browser_polling
    @restore.call(@id, 'presentation')
    assert_equal :already_restored, @restore.call(@id, 'presentation')
    File.write(@metadata, @initial)
    assert_equal :restored, @restore.call(@id, 'presentation')
    assert_equal @title, Nokogiri::XML(File.read(@metadata)).at_xpath('/recording/meta/name').text
    @restore.published(@id, 'presentation')
    # The request remains "requested" if the browser is closed. Consumption is
    # recorded by the server hook, so a later external rebuild remains untouched.
    File.write(@metadata, @initial.sub('Old title', 'External rebuild'))
    assert_equal :already_restored, @restore.call(@id, 'presentation')
    assert_includes File.read(@metadata), 'External rebuild'
    assert_equal 'published', marker['status']
  end

  def test_unrelated_jobs_no_title_and_failed_requests_do_not_modify_metadata
    File.unlink(@request_path)
    assert_equal :not_requested, @restore.call(@id, 'presentation')
    @request['recording_title'] = nil; write_request
    assert_equal :not_needed, @restore.call(@id, 'presentation')
    %w[failed command_failed].each do |status|
      @request['status'] = status; write_request
      assert_equal :not_requested, @restore.call(@id, 'presentation')
    end
    assert_equal @initial, File.read(@metadata)
    refute File.exist?(File.join(@state, @id, 'title-restore-presentation.json'))
  end

  def test_changed_raw_and_stale_processed_metadata_are_rejected_and_reported
    File.write(File.join(@raw, @id, 'events.xml'), 'changed')
    assert_raises(RuntimeError) { @restore.call(@id, 'presentation') }
    assert_equal 'failed', marker['status']
    assert_equal @initial, File.read(@metadata)
    File.write(File.join(@raw, @id, 'events.xml'), @xml)
    past = Time.now - 10
    File.utime(past, past, @metadata)
    assert_raises(RuntimeError) { @restore.call(@id, 'presentation') }
    assert_equal @initial, File.read(@metadata)
  end

  def test_invalid_xml_and_dtd_leave_metadata_unchanged
    ['invalid XML', '<!DOCTYPE recording [<!ENTITY x SYSTEM "file:///etc/passwd">]><recording><meta><name>&x;</name></meta></recording>'].each do |xml|
      File.write(@metadata, xml)
      assert_raises(StandardError) { @restore.call(@id, 'presentation') }
      assert_equal xml, File.read(@metadata)
      assert_equal 'failed', marker['status']
    end
  end

  def test_rejects_unsafe_arguments_and_symlinked_recording_paths
    [[@id + ';id', 'presentation'], [@id, '../presentation'], ['../' + @id, 'presentation']].each do |args|
      assert_raises(RuntimeError) { @restore.call(*args) }
    end
    outside = File.join(@dir, 'outside.xml')
    File.write(outside, @initial)
    File.unlink(@metadata); File.symlink(outside, @metadata)
    assert_raises(RuntimeError) { @restore.call(@id, 'presentation') }
    assert_equal @initial, File.read(outside)
    File.unlink(@metadata)
    folder = File.dirname(@metadata)
    FileUtils.rm_rf(folder)
    File.symlink(@dir, folder)
    assert_raises(RuntimeError) { @restore.call(@id, 'presentation') }
  end
end
