# frozen_string_literal: true
require 'minitest/autorun'
require 'minitest/mock'
require 'tmpdir'
require_relative '../lib/recording_editor'

class ContentSwitchesTest < Minitest::Test
  C = RecordingEditor::ContentSwitches
  def setup
    @dir = Dir.mktmpdir('content-switches')
    @id = "#{'c' * 40}-1700000000000"
    @repo = RecordingEditor::Repository.new(raw_root: File.join(@dir, 'raw'), state_root: File.join(@dir, 'state'))
    @raw = File.join(@repo.raw_root, @id)
    FileUtils.mkdir_p(File.join(@raw, 'deskshare'))
    FileUtils.mkdir_p(File.join(@raw, 'presentation', 'deck', 'svgs'))
    File.write(File.join(@raw, 'deskshare', 'screen.webm'), 'original video bytes')
    File.write(File.join(@raw, 'presentation', 'deck', 'svgs', 'slide1.svg'), '<svg/>')
    @repo.define_singleton_method(:probe) { |_| { 'streams' => [{ 'codec_type' => 'video' }], 'format' => { 'duration' => '10' } } }
    @xml = <<~XML
      <recording bbb_version="4.0.0">
        <event timestamp="10000" module="PARTICIPANT" eventname="ParticipantJoinEvent"><timestampUTC>1700000000000</timestampUTC></event>
        <event timestamp="10000" module="PRESENTATION" eventname="SharePresentationEvent"><presentationName>deck</presentationName><share>true</share></event>
        <event timestamp="10000" module="bbb-webrtc-sfu" eventname="StartWebRTCDesktopShareEvent"><filename>/deskshare/screen.webm</filename></event>
        <event timestamp="10000" module="PARTICIPANT" eventname="RecordStatusEvent"><status>true</status></event>
        <event timestamp="12000" module="PARTICIPANT" eventname="SetScreenshareAsContentEvent"><screenshareAsContent>false</screenshareAsContent><userId>presenter</userId></event>
        <event timestamp="14000" module="PARTICIPANT" eventname="SetScreenshareAsContentEvent"><screenshareAsContent>true</screenshareAsContent></event>
        <event timestamp="16000" module="PARTICIPANT" eventname="SetScreenshareAsContentEvent"><screenshareAsContent>false</screenshareAsContent></event>
        <event timestamp="20000" module="bbb-webrtc-sfu" eventname="StopWebRTCDesktopShareEvent"><filename>/deskshare/screen.webm</filename></event>
        <event timestamp="20000" module="PARTICIPANT" eventname="RecordStatusEvent"><status>false</status></event>
      </recording>
    XML
    write
  end
  def teardown
    FileUtils.remove_entry(@dir)
  end
  def write(xml = @xml)
    File.write(File.join(@raw, 'events.xml'), xml)
    @rec = @repo.recording(@id)
  end
  def override(from, to, source)
    { 'start_ms' => from, 'end_ms' => to, 'source' => source }
  end
  def sources(rec = @rec)
    C.timeline(rec).map { |s| [s['start_ms'], s['end_ms'], s['source'], s['inferred']] }
  end
  def payload(overrides)
    { 'revision' => @rec.revision, 'record_ranges' => [{ 'start_ms' => 0, 'end_ms' => 10000 }], 'beep_ranges' => [], 'content_overrides' => overrides }
  end

  def test_foreground_follows_switches_while_the_same_video_keeps_running
    assert_equal [[0, 2000, 'screen', true], [2000, 4000, 'slides', false], [4000, 6000, 'screen', false], [6000, 10000, 'slides', false]], sources
    assert C.timeline(@rec).all? { |s| s['screen_available'] && s['slides_available'] }
    assert_equal false, C.original_flag(@rec, 6000)
  end

  def test_layout_external_video_and_missing_content_are_explicit
    xml = @xml.sub('<event timestamp="14000"', '<event timestamp="13000" module="PARTICIPANT" eventname="LayoutBroadcastedEvent"><presentationIsOpen>false</presentationIsOpen></event><event timestamp="13500" module="PARTICIPANT" eventname="LayoutBroadcastedEvent"><presentationIsOpen>true</presentationIsOpen></event><event timestamp="14000"')
    xml = xml.sub('<event timestamp="16000"', '<event timestamp="15000" module="PRESENTATION" eventname="StartExternalVideoRecordEvent"/><event timestamp="15500" module="PRESENTATION" eventname="StopExternalVideoRecordEvent"/><event timestamp="16000"')
    write(xml)
    segments = C.timeline(@rec)
    assert_equal 'none', segments.find { |s| s['start_ms'] == 3000 }['source']
    assert_equal 'external', segments.find { |s| s['start_ms'] == 5000 }['source']
    assert_raises(RecordingEditor::Error) { C.normalize([override(2500, 3500, 'slides')], @rec) }
    assert_raises(RecordingEditor::Error) { C.normalize([override(5000, 5500, 'screen')], @rec) }
    File.unlink(File.join(@raw, 'deskshare', 'screen.webm')); @rec = @repo.recording(@id)
    assert_equal 'screen', C.timeline(@rec).first['source']
    refute C.timeline(@rec).first['available']
    assert_raises(RecordingEditor::Error) { C.normalize([override(0, 2000, 'screen')], @rec) }
  end

  def test_unknown_flags_do_not_change_the_default_and_older_recordings_stay_read_only
    write(@xml.gsub('<screenshareAsContent>false</screenshareAsContent>', '<screenshareAsContent>unknown</screenshareAsContent>').sub('bbb_version="4.0.0"', 'bbb_version="3.0.0"'))
    assert_equal 'screen', sources.first[2]
    refute C.editable?(@rec)
    assert_raises(RecordingEditor::Error) { C.normalize([override(0, 2000, 'slides')], @rec) }
    assert_equal [], C.normalize([], @rec)
    write(@xml.sub('bbb_version="4.0.0"', 'bbb_version="3.0.14"'))
    assert C.editable?(@rec)
  end

  def test_validation_rejects_bad_types_bounds_sources_overlaps_and_nonfinite_numbers
    [false, {}, [nil], [override(1, 1, 'slides')], [override(-1, 2000, 'slides')], [override(0, 11000, 'slides')],
     [override(0, 1000, 'external')], [override(0, Float::INFINITY, 'slides')], [override(0, 3000, 'slides'), override(2000, 4000, 'screen')]].each do |invalid|
      assert_raises(RecordingEditor::Error) { C.normalize(invalid, @rec) }
    end
    assert_equal [override(0, 2000, 'slides')], C.normalize([override(0, 1000, 'slides'), override(1000, 2000, 'slides')], @rec)
  end

  def test_override_restores_the_original_state_after_equal_timestamp_events_and_keeps_navigation
    overrides = C.normalize([override(1000, 6000, 'screen'), override(6000, 8000, 'slides')], @rec)
    updated = RecordingEditor.xml(@rec.edited_xml(@rec.record_ranges, {}, content_overrides: overrides))
    controls = updated.xpath('/recording/event[@eventname="SetScreenshareAsContentEvent"]')
    at = ->(time) { controls.select { |e| e['timestamp'].to_i <= 10000 + time }.last.at_xpath('screenshareAsContent').text }
    assert_equal 'true', at.call(1000)
    assert_equal 'true', at.call(2000)
    assert_equal 'false', at.call(6000)
    assert_equal 'false', at.call(8000)
    assert_equal 'presenter', controls.find { |e| e['timestamp'] == '12000' }.at_xpath('userId').text
    assert_equal @rec.doc.xpath('/recording/event[@module="PRESENTATION"]').map(&:to_xml), updated.xpath('/recording/event[@module="PRESENTATION"]').map(&:to_xml)
    assert_equal @rec.doc.xpath('/recording/event[@module="bbb-webrtc-sfu"]').map(&:to_xml), updated.xpath('/recording/event[@module="bbb-webrtc-sfu"]').map(&:to_xml)
  end

  def test_save_reopen_draft_remove_and_reset_keep_the_original_switches_and_materials
    editor = RecordingEditor::Editor.new(@repo)
    changes = [override(1000, 6000, 'screen')]
    draft = editor.draft(@id, payload(changes))
    assert_equal changes, draft[:content_overrides]
    assert_equal @xml, File.read(File.join(@raw, 'events.xml'))
    result = editor.save(@id, payload(changes))
    assert_equal changes, result['content_overrides']
    @rec = @repo.recording(@id)
    assert_equal changes, @rec.to_h[:content_overrides]
    assert_equal [[0, 2000, 'screen', true], [2000, 4000, 'slides', false], [4000, 6000, 'screen', false], [6000, 10000, 'slides', false]], sources
    count = @rec.current_doc.xpath('/recording/event[@eventname="SetScreenshareAsContentEvent"]').length
    editor.save(@id, payload(changes)); @rec = @repo.recording(@id)
    assert_equal count, @rec.current_doc.xpath('/recording/event[@eventname="SetScreenshareAsContentEvent"]').length
    editor.save(@id, payload([])); @rec = @repo.recording(@id)
    assert_equal [], @rec.to_h[:content_overrides]
    assert_equal 3, @rec.current_doc.xpath('/recording/event[@eventname="SetScreenshareAsContentEvent"]').length
    editor.reset(@id, { 'revision' => @rec.revision, 'confirmed' => true })
    assert_equal @xml, File.read(File.join(@raw, 'events.xml'))
    assert_equal 'original video bytes', File.read(File.join(@raw, 'deskshare', 'screen.webm'))
  end
  def test_unsorted_raw_rejects_only_display_overrides_before_writing
    write(@xml.sub('timestamp="14000"', 'timestamp="17000"'))
    refute @rec.events_in_order
    refute C.editable?(@rec)
    assert_equal 'contentUnordered', @rec.to_h[:content_edit_reason]
    before = File.binread(File.join(@raw, 'events.xml'))
    assert_raises(RecordingEditor::Error) { RecordingEditor::Editor.new(@repo).save(@id, payload([override(2000, 4000, 'screen')])) }
    assert_equal before, File.binread(File.join(@raw, 'events.xml'))
    assert_equal [], C.normalize([], @rec)
  end

end
