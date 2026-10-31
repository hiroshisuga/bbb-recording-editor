# frozen_string_literal: true
require 'minitest/autorun'
require 'tmpdir'
require_relative '../lib/recording_editor'

class CutChimeTest < Minitest::Test
  def setup
    @dir = Dir.mktmpdir('bbb-chime-')
    @id = "#{'d' * 40}-1700000000000"
    @repo = RecordingEditor::Repository.new(raw_root: File.join(@dir, 'raw'), state_root: File.join(@dir, 'state'))
    @raw = File.join(@repo.raw_root, @id)
    FileUtils.mkdir_p([File.join(@raw, 'audio'), File.join(@raw, 'deskshare')])
    @events = <<~XML
      <recording>
        <event timestamp="1000" module="PARTICIPANT" eventname="ParticipantJoinEvent"/>
        <event timestamp="1000" module="VOICE" eventname="StartRecordingEvent"><filename>microphone.wav</filename></event>
        <event timestamp="2000" module="bbb-webrtc-sfu" eventname="StartWebRTCDesktopShareEvent"><filename>screen.mp4</filename></event>
        <event timestamp="2000" module="PARTICIPANT" eventname="RecordStatusEvent"><status>true</status></event>
        <event timestamp="6000" module="bbb-webrtc-sfu" eventname="StopWebRTCDesktopShareEvent"><filename>screen.mp4</filename></event>
        <event timestamp="6000" module="PARTICIPANT" eventname="RecordStatusEvent"><status>false</status></event>
        <event timestamp="7000" module="VOICE" eventname="StopRecordingEvent"><filename>microphone.wav</filename></event>
        <event timestamp="7000" module="MEETING" eventname="EndAndKickAllEvent"/>
      </recording>
    XML
    File.write(File.join(@raw, 'events.xml'), @events)
    @records = [{ 'start_ms' => 500, 'end_ms' => 2500 }, { 'start_ms' => 3500, 'end_ms' => 6000 }]
    @editor = RecordingEditor::Editor.new(@repo)
  end

  def teardown
    FileUtils.remove_entry(@dir)
  end

  def payload(beeps: [], enabled: true, records: @records)
    { 'revision' => @repo.recording(@id).revision, 'record_ranges' => records, 'beep_ranges' => beeps, 'cut_chime' => enabled }
  end

  def sources
    RecordingEditor.run('ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', File.join(@raw, 'audio', 'microphone.wav'))
    RecordingEditor.run('ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=5:d=4',
                        '-f', 'lavfi', '-i', 'sine=frequency=880:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', File.join(@raw, 'deskshare', 'screen.mp4'))
  end

  def rms(path, start)
    samples = RecordingEditor.run('ffmpeg', '-nostdin', '-v', 'error', '-ss', start.to_s, '-i', path, '-t', '0.05',
                                 '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-').unpack('e*')
    Math.sqrt(samples.sum { |s| s * s } / samples.size)
  end

  def test_plan_skips_outer_trims_original_off_gaps_and_subframe_cuts
    original = [{ 'start_ms' => 0, 'end_ms' => 1000 }, { 'start_ms' => 2000, 'end_ms' => 3000 }]
    assert_empty RecordingEditor::CutChime.ranges(original, original, 3000)
    assert_empty RecordingEditor::CutChime.ranges([{ 'start_ms' => 500, 'end_ms' => 2000 }], [], 3000)
    [19, 20, 70, 250, 500].each do |gap|
      ranges = [{ 'start_ms' => 0, 'end_ms' => 1000 }, { 'start_ms' => 1000 + gap, 'end_ms' => 3000 }]
      cues = RecordingEditor::CutChime.ranges(ranges, [], 3000)
      assert_equal(gap < 20 ? [] : [{ 'start_ms' => 1000, 'end_ms' => 1000 + [250, gap].min }], cues)
    end
  end

  def test_save_adds_exact_sound_a_and_mutes_all_original_sources_even_under_a_beep
    sources
    originals = %w[audio/microphone.wav deskshare/screen.mp4].to_h { |r| [r, Digest::SHA256.file(File.join(@raw, r)).hexdigest] }
    result = @editor.save(@id, payload(beeps: [{ 'start_ms' => 2400, 'end_ms' => 2900 }]))
    cue = result['outputs'].find { |o| o[:cue] }
    assert_equal Digest::SHA256.file(RecordingEditor::CutChime::SAMPLE).hexdigest, Digest::SHA256.file(File.join(@raw, cue[:relative])).hexdigest
    assert_operator rms(File.join(@raw, cue[:relative]), 0.04), :>, 0.02
    mic = result['outputs'].find { |o| o[:source] == 'audio/microphone.wav' }
    screen = result['outputs'].find { |o| o[:source] == 'deskshare/screen.mp4' }
    assert_operator rms(File.join(@raw, mic[:relative]), 2.56), :<, 0.001
    assert_operator rms(File.join(@raw, screen[:relative]), 1.56), :<, 0.003
    assert_operator rms(File.join(@raw, mic[:relative]), 3.8), :>, 0.03
    video_hash = ->(path) { RecordingEditor.run('ffmpeg', '-nostdin', '-v', 'error', '-i', path, '-map', '0:v:0', '-c:v', 'copy', '-f', 'hash', '-hash', 'sha256', '-') }
    assert_equal video_hash.call(File.join(@raw, 'deskshare/screen.mp4')), video_hash.call(File.join(@raw, screen[:relative]))
    assert_equal 4750, result['effective_record_ranges'].sum { |r| r['end_ms'] - r['start_ms'] }
    originals.each { |relative, sha| assert_equal sha, Digest::SHA256.file(File.join(@raw, relative)).hexdigest }
    xml = @repo.recording(@id).current_doc
    assert_empty xml.xpath('/recording/event[@eventname="StartRecordingEvent"]')
    assert_equal 2, xml.xpath('/recording/event[@eventname="AudioTrackPublishedEvent"]').size
  end

  def test_repeated_saves_preserve_logical_ranges_and_preview_identity_and_disable_removes_cue_references
    sources
    key = @repo.recording(@id).to_h[:preview_key]
    2.times do
      result = @editor.save(@id, payload)
      rec = @repo.recording(@id)
      assert_equal @records, rec.record_ranges
      assert_equal 2750, rec.record_ranges(rec.current_doc).first['end_ms']
      assert_equal @records, rec.to_h[:record_ranges]
      assert_equal true, rec.to_h[:cut_chime]
      assert_equal key, rec.to_h[:preview_key]
      assert_equal 2750, result['effective_record_ranges'].first['end_ms']
    end
    @editor.save(@id, payload(enabled: false))
    rec = @repo.recording(@id)
    assert_equal @records, rec.record_ranges(rec.current_doc)
    assert_equal false, rec.to_h[:cut_chime]
    assert_equal 'microphone.wav', rec.current_doc.at_xpath('/recording/event[@eventname="StartRecordingEvent"]/filename').text
  end

  def test_cue_in_a_silent_gap_is_shortened_and_reset_archives_it
    # No audio files or audio timing events: synthesize the cue as its own track.
    xml = RecordingEditor.xml(@events)
    xml.xpath('/recording/event[filename]').each(&:remove)
    File.write(File.join(@raw, 'events.xml'), xml.to_xml)
    FileUtils.rmdir(File.join(@raw, 'audio'))
    records = [{ 'start_ms' => 500, 'end_ms' => 2500 }, { 'start_ms' => 2570, 'end_ms' => 6000 }]
    result = @editor.save(@id, payload(records: records))
    cue = result['outputs'].first
    assert_equal({ 'start_ms' => 2500, 'end_ms' => 2570 }, cue[:cue])
    duration = @repo.probe(File.join(@raw, cue[:relative])).dig('format', 'duration').to_f
    assert_in_delta 0.07, duration, 0.001
    assert_equal 1, @repo.recording(@id).current_doc.xpath('/recording/event[@eventname="AudioTrackPublishedEvent"]').size
    reset = @editor.reset(@id, { 'revision' => result['revision'], 'confirmed' => true })
    refute File.exist?(File.join(@raw, cue[:relative]))
    assert File.file?(File.join(reset['archive'], 'media', cue[:relative]))
    assert_equal false, @repo.recording(@id).to_h[:cut_chime]
    assert_equal File.binread(File.join(@repo.state_dir(@id), 'original-events.xml')), File.binread(File.join(@raw, 'events.xml'))
  end

  def test_draft_roundtrips_the_flag_and_invalid_flags_are_rejected
    draft = @editor.draft(@id, payload)
    assert_equal true, draft[:cut_chime]
    assert_equal true, JSON.parse(File.read(File.join(@repo.state_dir(@id), 'draft.json')))['cut_chime']
    assert_raises(RecordingEditor::Error) { @editor.draft(@id, payload.merge('cut_chime' => 'yes')) }
    assert_raises(RecordingEditor::Error) { @editor.save(@id, payload.merge('cut_chime' => 1)) }
    assert_equal @events, File.read(File.join(@raw, 'events.xml'))
  end
end
