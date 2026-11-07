# frozen_string_literal: true

require 'minitest/autorun'
require 'tmpdir'
require 'minitest/mock'
require 'cgi'
require_relative '../lib/recording_editor'

class MeetingListTest < Minitest::Test
  def setup
    @dir = Dir.mktmpdir('bbb-list-')
    @now = Time.utc(2026, 10, 10, 12)
    @id = "#{'a' * 40}-#{(@now.to_f * 1000).to_i - 60_000}"
    @repo = RecordingEditor::Repository.new(raw_root: File.join(@dir, 'recording', 'raw'),
      state_root: File.join(@dir, 'editor'), published_root: File.join(@dir, 'published', 'presentation'),
      unpublished_root: File.join(@dir, 'unpublished', 'presentation'))
  end

  def teardown
    FileUtils.remove_entry(@dir)
  end

  def raw(marks = '', id = @id)
    path = File.join(@repo.raw_root, id, 'events.xml')
    FileUtils.mkdir_p(File.dirname(path))
    File.write(path, "<recording><metadata meetingName='Raw meeting'/><event timestamp='1000' eventname='ParticipantJoinEvent'/>#{marks}<event timestamp='11000' eventname='EndAndKickAllEvent'/></recording>")
  end

  def marks
    "<event timestamp='2000' eventname='RecordStatusEvent'><status>true</status></event>" \
      "<event timestamp='4000' eventname='RecordStatusEvent'><status>false</status></event>" \
      "<event timestamp='7000' eventname='RecordStatusEvent'><status>true</status></event>"
  end

  def metadata(root, state, published, id = @id, title: nil)
    path = File.join(root, id, 'metadata.xml')
    FileUtils.mkdir_p(File.dirname(path))
    name = title.nil? ? '' : "<name>#{CGI.escapeHTML(title)}</name>"
    File.write(path, "<recording><state>#{state}</state><published>#{published}</published><start_time>100000</start_time><end_time>110000</end_time><meta><meetingName>Metadata meeting</meetingName>#{name}</meta><playback><duration>3000</duration></playback></recording>")
    path
  end

  def item
    @repo.list(now: @now).find { |entry| entry[:id] == @id }
  end

  def test_recorded_duration_counts_only_marks_and_preserves_open_ended_range
    raw(marks)
    assert_equal 'marked', item[:recording_status]
    assert_equal 6000, item[:recorded_duration_ms]
    assert_equal 10_000, item[:duration_ms]
    assert_equal 'not_generated', item[:publication_status]
    assert item[:raw_available]
  end

  def test_no_marks_leave_recording_intervals_empty_in_the_list_and_editor
    raw
    path = File.join(@repo.raw_root, @id, 'events.xml')
    before = File.binread(path)
    assert_equal 'unmarked', item[:recording_status]
    assert_equal 0, item[:recorded_duration_ms]
    rec = @repo.recording(@id)
    assert_empty rec.record_ranges
    manifest = rec.to_h
    assert_empty manifest[:record_ranges]
    assert_empty manifest[:original_record_ranges]
    refute manifest[:record_ranges_persisted]
    assert_equal before, File.binread(path)
    raw("<event timestamp='4000' eventname='RecordStatusEvent'><status>false</status></event>")
    assert_equal 'unmarked', item[:recording_status]
    assert_equal 0, item[:recorded_duration_ms]
    assert_empty @repo.recording(@id).record_ranges
  end

  def test_unpublish_move_is_detected_without_raw_and_uses_metadata_name
    path = metadata(@repo.published_root, 'published', 'true')
    assert_equal 'published', item[:publication_status]
    assert_equal 'Metadata meeting', item[:name]
    assert_equal 10_000, item[:duration_ms]
    assert_equal 3000, item[:playback_duration_ms]
    refute item[:raw_available]
    assert_equal 'unknown', item[:recording_status]
    assert_nil item[:recorded_duration_ms]
    FileUtils.remove_entry(File.dirname(path))
    metadata(@repo.unpublished_root, 'unpublished', 'false')
    assert_equal 'unpublished', item[:publication_status]
  end

  def test_editor_heading_prefers_recording_title_and_keeps_room_name_separate
    raw(marks)
    rec = @repo.recording(@id)
    key = rec.to_h[:preview_key]
    assert_equal 'Raw meeting', rec.to_h[:name]
    assert_equal 'Raw meeting', rec.to_h[:meeting_name]
    assert_nil rec.to_h[:recording_title]
    path = metadata(@repo.published_root, 'published', 'true', title: '講義 <A> & Part 1')
    data = @repo.recording(@id).to_h
    assert_equal '講義 <A> & Part 1', data[:name]
    assert_equal 'Raw meeting', data[:meeting_name]
    assert_equal data[:name], data[:recording_title]
    assert_equal key, data[:preview_key]
    FileUtils.rm_rf(File.dirname(path))
    metadata(@repo.unpublished_root, 'unpublished', 'false', title: 'Unpublished title')
    assert_equal 'Unpublished title', @repo.recording(@id).to_h[:name]
    assert_nil @repo.recording(@id).to_h[:published_url]
  end

  def test_editor_playback_link_follows_publication_changes
    raw(marks)
    raw_path = File.join(@repo.raw_root, @id, 'events.xml')
    before = File.binread(raw_path)
    assert_nil @repo.recording(@id).to_h[:published_url]
    path = metadata(@repo.published_root, 'published', 'true')
    assert_equal "/playback/presentation/2.3/#{@id}", @repo.recording(@id).to_h[:published_url]
    FileUtils.remove_entry(File.dirname(path))
    path = metadata(@repo.unpublished_root, 'unpublished', 'false')
    assert_nil @repo.recording(@id).to_h[:published_url]
    FileUtils.remove_entry(File.dirname(path))
    metadata(@repo.process_root, 'processing', 'false')
    assert_nil @repo.recording(@id).to_h[:published_url]
    assert_equal before, File.binread(raw_path)
  end

  def test_editor_playback_link_is_hidden_when_publication_is_unknown
    raw(marks)
    path = metadata(@repo.published_root, 'published', 'false')
    assert_nil @repo.recording(@id).to_h[:published_url]
    File.write(path, 'invalid XML')
    assert_nil @repo.recording(@id).to_h[:published_url]
    metadata(@repo.published_root, 'published', 'true')
    metadata(@repo.unpublished_root, 'unpublished', 'false')
    assert_nil @repo.recording(@id).to_h[:published_url]
  end

  def test_marked_recordings_use_renamed_titles_for_published_and_unpublished_states
    raw(marks)
    raw_path = File.join(@repo.raw_root, @id, 'events.xml')
    before = File.binread(raw_path)
    path = metadata(@repo.published_root, 'published', 'true', title: '  講義 <第1回> & introduction  ')
    metadata_before = File.binread(path)
    assert_equal '講義 <第1回> & introduction', item[:name]
    assert_equal 'Raw meeting', item[:meeting_name]
    assert_equal 'published', item[:publication_status]
    assert_equal 'marked', item[:recording_status]
    assert_equal metadata_before, File.binread(path)
    FileUtils.remove_entry(File.dirname(path))
    metadata(@repo.unpublished_root, 'unpublished', 'false', title: '非公開の講義タイトル')
    assert_equal '非公開の講義タイトル', item[:name]
    assert_equal 'Raw meeting', item[:meeting_name]
    assert_equal 'unpublished', item[:publication_status]
    assert_equal before, File.binread(raw_path)
  end

  def test_unmarked_meetings_keep_the_room_name_even_if_old_recording_metadata_has_a_title
    raw
    metadata(@repo.unpublished_root, 'unpublished', 'false', title: 'Old recording title')
    assert_equal 'Raw meeting', item[:name]
    assert_equal 'unmarked', item[:recording_status]
    assert_equal 'Raw meeting', item[:meeting_name]
    raw(marks)
    assert_equal 'Old recording title', item[:name]
  end

  def test_missing_empty_or_invalid_title_metadata_falls_back_to_the_raw_meeting_name
    raw(marks)
    assert_equal 'Raw meeting', item[:name]
    path = metadata(@repo.published_root, 'published', 'true')
    assert_equal 'Raw meeting', item[:name]
    metadata(@repo.published_root, 'published', 'true', title: '  ')
    assert_equal 'Raw meeting', item[:name]
    File.write(path, 'invalid XML')
    assert_equal 'Raw meeting', item[:name]
    assert item[:raw_available]
  end

  def test_title_changes_are_reread_when_the_list_is_refreshed
    raw(marks)
    metadata(@repo.unpublished_root, 'unpublished', 'false', title: 'First title')
    assert_equal 'First title', item[:name]
    metadata(@repo.unpublished_root, 'unpublished', 'false', title: 'Updated title')
    assert_equal 'Updated title', item[:name]
  end

  def test_renamed_titles_remain_available_when_raw_has_expired
    metadata(@repo.unpublished_root, 'unpublished', 'false', title: 'Archived recording title')
    assert_equal 'Archived recording title', item[:name]
    assert_equal 'Metadata meeting', item[:meeting_name]
    refute item[:raw_available]
    assert_equal 'unknown', item[:recording_status]
  end

  def test_saved_intervals_update_list_without_changing_publication_status
    raw(marks)
    metadata(@repo.unpublished_root, 'unpublished', 'false')
    rec = @repo.recording(@id)
    RecordingEditor::Editor.new(@repo).save(@id, {
      'revision' => rec.revision, 'record_ranges' => [{ 'start_ms' => 500, 'end_ms' => 9500 }], 'beep_ranges' => []
    })
    assert_equal 9000, item[:recorded_duration_ms]
    assert_equal 'unpublished', item[:publication_status]
  end

  def test_processing_metadata_and_failed_jobs_are_not_mistaken_for_ready_recordings
    path = metadata(@repo.process_root, 'processing', 'false')
    assert_equal 'processing', item[:publication_status]
    metadata(@repo.process_root, 'processed', 'false')
    assert_equal 'processing', item[:publication_status]
    failure = File.join(@repo.status_root, 'published', "#{@id}-presentation.fail")
    FileUtils.mkdir_p(File.dirname(failure))
    File.write(failure, '')
    assert_equal 'unknown', item[:publication_status]
    assert item[:warnings].any? { |warning| warning.include?('失敗') }
    FileUtils.remove_entry(File.dirname(path))
    raw
    assert_equal 'unknown', item[:publication_status]
    assert item[:raw_available]
  end

  def test_missing_invalid_or_conflicting_metadata_does_not_hide_readable_raw
    raw(marks)
    FileUtils.mkdir_p(File.join(@repo.published_root, @id))
    assert_equal 'unknown', item[:publication_status]
    assert item[:raw_available]
    path = metadata(@repo.published_root, 'published', 'false')
    assert_equal 'unknown', item[:publication_status]
    File.write(path, '<!DOCTYPE recording [<!ENTITY x SYSTEM "file:///etc/passwd">]><recording>&x;</recording>')
    assert_equal 'unknown', item[:publication_status]
    assert item[:warnings].any? { |warning| warning.include?('DTD') }
    metadata(@repo.published_root, 'published', 'true')
    metadata(@repo.unpublished_root, 'unpublished', 'false')
    assert_equal 'unknown', item[:publication_status]
    assert item[:warnings].any? { |warning| warning.include?('両方') }
  end

  def test_unreadable_raw_keeps_known_publication_state
    raw
    File.write(File.join(@repo.raw_root, @id, 'events.xml'), 'invalid XML')
    metadata(@repo.unpublished_root, 'unpublished', 'false')
    assert_equal 'unpublished', item[:publication_status]
    assert_equal 'unknown', item[:recording_status]
    refute item[:raw_available]
    assert item[:warnings].any? { |warning| warning.include?('rawデータを読み込めません') }
  end

  def test_list_has_no_age_cutoff_and_remains_sorted_by_meeting_id
    raw
    old = "#{'b' * 40}-#{((@now - 15 * 86_400).to_f * 1000).to_i}"
    future = "#{'c' * 40}-#{((@now + 60).to_f * 1000).to_i}"
    newer = "#{'d' * 40}-#{(@now.to_f * 1000).to_i - 10_000}"
    metadata(@repo.unpublished_root, 'unpublished', 'false', old)
    metadata(@repo.process_root, 'processing', 'false', future)
    metadata(@repo.published_root, 'published', 'true', newer)
    assert_equal [newer, @id, old], @repo.list(now: @now).map { |entry| entry[:id] }
  end

  def test_retained_old_raw_is_available_regardless_of_publication_or_recording_marks
    published = "#{'b' * 40}-#{((@now - 400 * 86_400).to_f * 1000).to_i}"
    unpublished = "#{'c' * 40}-#{((@now - 3650 * 86_400).to_f * 1000).to_i}"
    raw(marks, published)
    raw('', unpublished)
    path = metadata(@repo.published_root, 'published', 'true', published, title: 'Retained lecture')
    metadata(@repo.unpublished_root, 'unpublished', 'false', unpublished)
    files = [path, File.join(@repo.raw_root, published, 'events.xml'), File.join(@repo.raw_root, unpublished, 'events.xml')]
    before = files.to_h { |file| [file, File.binread(file)] }
    entries = @repo.list(now: @now)
    assert_equal [published, unpublished], entries.map { |entry| entry[:id] }
    assert entries.all? { |entry| entry[:raw_available] }
    assert_equal 'Retained lecture', entries.first[:name]
    assert_equal 'published', entries.first[:publication_status]
    assert_equal 'unmarked', entries.last[:recording_status]
    assert @repo.recording(published).duration.positive?
    before.each { |file, bytes| assert_equal bytes, File.binread(file) }
  end
  def test_raw_presence_is_independent_of_recording_xml_and_marks
    raw
    assert_equal 'present', item[:raw_data_status]
    assert_equal 'unmarked', item[:recording_status]
    File.write(File.join(@repo.raw_root, @id, 'events.xml'), 'invalid XML')
    assert_equal 'present', item[:raw_data_status]
    assert_equal 'unknown', item[:recording_status]
    refute item[:raw_available] # Retained compatibility field means XML loadability.
    File.unlink(File.join(@repo.raw_root, @id, 'events.xml'))
    FileUtils.mkdir_p(File.join(@repo.raw_root, @id, 'audio'))
    assert_equal 'missing', item[:raw_data_status]
    File.binwrite(File.join(@repo.raw_root, @id, 'audio', 'microphone.webm'), 'audio')
    assert_equal 'present', item[:raw_data_status]
    assert_equal 'unknown', item[:recording_status]
    assert item[:warnings].any? { |warning| warning.include?('events.xmlがありません') }
  end

  def test_missing_and_uninspectable_raw_are_not_conflated
    metadata(@repo.published_root, 'published', 'true')
    assert_equal 'missing', item[:raw_data_status]
    FileUtils.mkdir_p(File.join(@repo.raw_root, @id))
    assert_equal 'missing', item[:raw_data_status]
    lstat = File.method(:lstat)
    File.stub(:lstat, lambda { |path| raise Errno::EACCES if path == File.join(@repo.raw_root, @id); lstat.call(path) }) do
      assert_equal 'unknown', item[:raw_data_status]
      assert item[:warnings].any? { |warning| warning.include?('有無を確認できません') }
    end
    File.symlink('/etc/passwd', File.join(@repo.raw_root, @id, 'link'))
    assert_equal 'unknown', item[:raw_data_status]
  end

  def test_generation_and_publication_uncertainty_are_separate
    raw
    assert_equal 'not_generated', item[:generation_status]
    FileUtils.mkdir_p(File.join(@repo.published_root, @id))
    assert_equal 'unknown', item[:generation_status]
    path = metadata(@repo.published_root, 'published', 'false')
    assert_equal 'generated', item[:generation_status]
    assert_equal 'unknown', item[:publication_status]
    File.write(path, 'invalid XML')
    assert_equal 'unknown', item[:generation_status]
    metadata(@repo.published_root, 'published', 'true')
    metadata(@repo.unpublished_root, 'unpublished', 'false')
    assert_equal 'generated', item[:generation_status]
    assert_equal 'unknown', item[:publication_status]
  end

  def test_processing_and_rebuild_requests_set_generation_status
    raw
    metadata(@repo.process_root, 'processed', 'false')
    assert_equal 'processing', item[:generation_status]
    FileUtils.rm_rf(File.join(@repo.process_root, @id))
    @repo.write_rebuild_info(@id, { 'status' => 'requested', 'requested_at' => @now.iso8601 })
    assert_equal 'processing', item[:generation_status]
    @repo.write_rebuild_info(@id, { 'status' => 'command_failed' })
    assert_equal 'unknown', item[:generation_status]
  end

  def test_inaccessible_publication_paths_are_unknown_not_ungenerated
    raw
    stat = File.method(:stat)
    File.stub(:stat, lambda { |path| raise Errno::EACCES if path == File.join(@repo.published_root, @id); stat.call(path) }) do
      assert_equal 'unknown', item[:generation_status]
      assert_equal 'unknown', item[:publication_status]
      assert_equal 'present', item[:raw_data_status]
      assert item[:warnings].any? { |warning| warning.include?('生成・公開状態を確認できません') }
    end
  end

  def test_failed_rebuild_does_not_hide_known_generated_output
    metadata(@repo.published_root, 'published', 'true')
    @repo.write_rebuild_info(@id, { 'status' => 'command_failed' })
    assert_equal 'generated', item[:generation_status]
    assert_equal 'unknown', item[:publication_status]
    assert_equal 'missing', item[:raw_data_status]
  end

end
