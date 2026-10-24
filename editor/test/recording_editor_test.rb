# frozen_string_literal: true

require 'minitest/autorun'
require 'tmpdir'
require_relative '../lib/recording_editor'

class RecordingEditorTest < Minitest::Test
  def setup
    @dir = Dir.mktmpdir('bbb editor test ')
    @id = "#{'a' * 40}-#{(Time.now.to_f * 1000).to_i}"
    @raw = File.join(@dir, 'raw', @id)
    FileUtils.mkdir_p([File.join(@raw, 'audio'), File.join(@raw, 'deskshare')])
    @repo = RecordingEditor::Repository.new(raw_root: File.join(@dir, 'raw'), state_root: File.join(@dir, 'state'), published_root: File.join(@dir, 'published'))
    @origin = 8_000_000_000
    @utc = Time.now.to_i * 1000
    @events = <<~XML
      <?xml version="1.0" encoding="UTF-8"?>
      <recording meeting_id="#{@id}" bbb_version="4.0.0">
        <metadata meetingName="編集テスト &amp; meeting"/>
        <event timestamp="#{@origin}" module="PARTICIPANT" eventname="ParticipantJoinEvent"><timestampUTC>#{@utc}</timestampUTC><userId>moderator</userId><role>MODERATOR</role><name>Alice</name></event>
        <event timestamp="#{@origin}" module="VOICE" eventname="StartRecordingEvent"><filename>/server/audio/microphone.wav</filename><bridge>99999</bridge></event>
        <event timestamp="#{@origin + 1000}" module="bbb-webrtc-sfu" eventname="StartWebRTCDesktopShareEvent"><filename>/server/deskshare/screen.mp4</filename></event>
        <event timestamp="#{@origin + 1000}" module="PARTICIPANT" eventname="RecordStatusEvent"><status>true</status><userId>moderator</userId></event>
        <event timestamp="#{@origin + 2500}" module="PRESENTATION" eventname="GotoSlideEvent"><slide>2</slide><presentationName>slides</presentationName></event>
        <event timestamp="#{@origin + 5000}" module="bbb-webrtc-sfu" eventname="StopWebRTCDesktopShareEvent"><filename>/server/deskshare/screen.mp4</filename></event>
        <event timestamp="#{@origin + 5000}" module="PARTICIPANT" eventname="RecordStatusEvent"><status>false</status><userId>moderator</userId></event>
        <event timestamp="#{@origin + 6000}" module="VOICE" eventname="StopRecordingEvent"><filename>/server/audio/microphone.wav</filename></event>
        <event timestamp="#{@origin + 6000}" module="MEETING" eventname="EndAndKickAllEvent"><timestampUTC>#{@utc + 6000}</timestampUTC></event>
      </recording>
    XML
    File.write(File.join(@raw, 'events.xml'), @events)
  end

  def teardown
    FileUtils.remove_entry(@dir)
  end

  def sources
    RecordingEditor.run('ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:a', 'pcm_s16le', File.join(@raw, 'audio', 'microphone.wav'))
    RecordingEditor.run('ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=5:d=4', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', File.join(@raw, 'deskshare', 'screen.mp4'))
  end

  def payload(rec = @repo.recording(@id), beeps = [])
    { 'revision' => rec.revision, 'record_ranges' => [{ 'start_ms' => 500, 'end_ms' => 2500 }, { 'start_ms' => 3500, 'end_ms' => 6000 }], 'beep_ranges' => beeps }
  end

  def samples(path, start, duration = 0.2)
    RecordingEditor.run('ffmpeg', '-nostdin', '-v', 'error', '-ss', start.to_s, '-i', path, '-t', duration.to_s, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-').unpack('e*')
  end

  def rms(values)
    Math.sqrt(values.sum { |v| v * v } / values.size)
  end

  def timestamp_gap_source
    path = File.join(@raw, 'audio', 'microphone.webm')
    # A late 20ms PTS gap starts soft compensation at matching 48kHz rates.
    # Distinct later tones expose both inserted silence and delayed audio.
    signal = "aevalsrc='0.1*sin(2*PI*if(lt(t,4),440,if(lt(t,8),880,1320))*t)':s=48000:d=12"
    RecordingEditor.run('ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', signal,
      '-af', 'asetnsamples=n=960:p=0,asetpts=PTS+if(gte(T\,4)\,960\,0)', '-ac', '2', '-c:a', 'libopus', path)
    pts = RecordingEditor.run('ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_packets',
      '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', path).lines.filter_map { |line| Float(line.strip.split(',').first, exception: false) }
    assert pts.each_cons(2).any? { |a, b| (b - a - 0.04).abs < 0.001 }, 'fixture must retain the 20ms gap'
    File.write(File.join(@raw, 'events.xml'), <<~XML)
      <recording>
        <event timestamp="#{@origin}" eventname="ParticipantJoinEvent"><userId>moderator</userId></event>
        <event timestamp="#{@origin + 500}" module="bbb-webrtc-sfu" eventname="AudioTrackPublishedEvent"><filename>/server/audio/microphone.webm</filename></event>
        <event timestamp="#{@origin + 500}" eventname="RecordStatusEvent"><status>true</status></event>
        <event timestamp="#{@origin + 12_520}" module="bbb-webrtc-sfu" eventname="AudioTrackUnpublishedEvent"><filename>/server/audio/microphone.webm</filename></event>
        <event timestamp="#{@origin + 12_520}" eventname="RecordStatusEvent"><status>false</status></event>
        <event timestamp="#{@origin + 14_000}" eventname="EndAndKickAllEvent"/>
      </recording>
    XML
    path
  end

  def assert_tone_at(path, position, frequency)
    values = samples(path, position)
    assert_operator rms(values), :>, 0.03, "missing audio at #{position}s"
    crossings = values.each_cons(2).count { |a, b| a <= 0 && b > 0 }
    # Soft clock correction may briefly alter pitch by a few percent.
    assert_in_delta frequency, crossings * 16_000.0 / values.size, frequency * 0.05,
                    "wrong tone at #{position}s"
  end

  def test_xml_only_keeps_non_mark_events_and_uses_both_clocks
    rec = @repo.recording(@id)
    assert_equal 6000, rec.duration
    assert_equal [{ 'start_ms' => 1000, 'end_ms' => 5000 }], rec.record_ranges
    result = RecordingEditor::Editor.new(@repo).save(@id, payload(rec))
    assert File.file?(result['xml_backup'])
    assert_equal @events, File.read(result['xml_backup'])
    edited = @repo.recording(@id).current_doc
    before = rec.doc.xpath('/recording/event[@eventname!="RecordStatusEvent"]').map(&:to_xml)
    after = edited.xpath('/recording/event[@eventname!="RecordStatusEvent"]').map(&:to_xml)
    assert_equal before, after
    marks = edited.xpath('/recording/event[@eventname="RecordStatusEvent"]')
    assert_equal [@origin + 500, @origin + 2500, @origin + 3500, @origin + 6000], marks.map { |m| m['timestamp'].to_i }
    assert_equal @utc + 500, marks.first.at_xpath('timestampUTC').text.to_i
    assert_equal 'moderator', marks.first.at_xpath('userId').text
  end

  def test_visual_events_preserve_presentation_sharing_state_for_timeline_boundaries
    extra = <<~XML
      <event timestamp="#{@origin + 1000}" eventname="SharePresentationEvent"><presentationName>deck-A</presentationName><share>true</share></event>
      <event timestamp="#{@origin + 3000}" eventname="SharePresentationEvent"><presentationName>deck-A</presentationName><share>false</share></event>
      <event timestamp="#{@origin + 4000}" eventname="SharePresentationEvent"><presentationName>deck-B</presentationName></event>
    XML
    bytes = @events.sub('</recording>', extra + '</recording>')
    File.write(File.join(@raw, 'events.xml'), bytes)
    shares = @repo.recording(@id).visual_events.select { |event| event['type'] == 'SharePresentationEvent' }
    assert_equal [1000, 3000, 4000], shares.map { |event| event['time_ms'] }
    assert_equal %w[deck-A deck-A deck-B], shares.map { |event| event['presentation'] }
    assert_equal ['true', 'false', nil], shares.map { |event| event['share'] }
    assert_equal bytes, File.read(File.join(@raw, 'events.xml'))
  end

  def test_presentation_filenames_are_mapped_to_sharing_and_navigation_without_changing_raw
    extra = <<~XML
      <event timestamp="#{@origin + 100}" eventname="ConversionCompletedEvent"><presentationName>deck-A</presentationName><originalFilename>講義 &amp; introduction.pptx</originalFilename></event>
      <event timestamp="#{@origin + 200}" eventname="ConversionCompletedEvent"><presentationName>deck-B</presentationName><originalFilename>C:\\uploads\\第二部.pdf</originalFilename></event>
      <event timestamp="#{@origin + 300}" eventname="ConversionCompletedEvent"><presentationName>deck-A</presentationName><originalFilename> </originalFilename></event>
      <event timestamp="#{@origin + 1000}" eventname="SharePresentationEvent"><presentationName>deck-A</presentationName><share>true</share></event>
      <event timestamp="#{@origin + 2000}" eventname="GotoSlideEvent"><presentationName>deck-A</presentationName><slide>1</slide></event>
      <event timestamp="#{@origin + 3000}" eventname="SharePresentationEvent"><presentationName>deck-B</presentationName><share>true</share></event>
      <event timestamp="#{@origin + 4000}" eventname="GotoSlideEvent"><presentationName>unknown</presentationName><slide>1</slide></event>
    XML
    bytes = @events.sub('</recording>', extra + '</recording>')
    File.write(File.join(@raw, 'events.xml'), bytes)
    events = @repo.recording(@id).visual_events
    a = events.select { |event| event['presentation'] == 'deck-A' }
    assert_equal ['SharePresentationEvent', 'GotoSlideEvent'], a.map { |event| event['type'] }
    assert a.all? { |event| event['presentation_filename'] == '講義 & introduction.pptx' }
    assert_equal '第二部.pdf', events.find { |event| event['presentation'] == 'deck-B' }['presentation_filename']
    assert_nil events.find { |event| event['presentation'] == 'unknown' }['presentation_filename']
    assert_equal bytes, File.read(File.join(@raw, 'events.xml'))
  end

  def test_empty_recording_is_rejected_without_rewriting_xml
    rec = @repo.recording(@id)
    data = payload(rec)
    data['record_ranges'] = []
    assert_raises(RecordingEditor::Error) { RecordingEditor::Editor.new(@repo).save(@id, data) }
    assert_equal @events, File.read(File.join(@raw, 'events.xml'))
  end

  def test_overlap_ranges_merge_and_invalid_input_is_rejected
    assert_equal [{ 'start_ms' => 1, 'end_ms' => 8 }], RecordingEditor.ranges([{ 'start_ms' => 1, 'end_ms' => 5 }, { 'start_ms' => 4, 'end_ms' => 8 }], 10)
    [-1, Float::NAN, Float::INFINITY, '1'].each do |n|
      assert_raises(RecordingEditor::Error) { RecordingEditor.ranges([{ 'start_ms' => n, 'end_ms' => 5 }], 10) }
    end
    assert_raises(RecordingEditor::Error) { RecordingEditor.ranges([{ 'start_ms' => 1, 'end_ms' => 11 }], 10) }
  end

  def test_wrong_revision_does_not_change_xml
    data = payload
    data['revision'] = 'old'
    error = assert_raises(RecordingEditor::Error) { RecordingEditor::Editor.new(@repo).save(@id, data) }
    assert_equal 409, error.status
    assert_equal @events, File.read(File.join(@raw, 'events.xml'))
  end

  def test_path_traversal_and_xml_entities_are_rejected
    assert_raises(RecordingEditor::Error) { @repo.raw_file(@id, '../../etc/passwd') }
    File.symlink('/etc/passwd', File.join(@raw, 'audio', 'outside.wav'))
    assert_raises(RecordingEditor::Error) { @repo.raw_file(@id, 'audio/outside.wav') }
    assert_raises(RecordingEditor::Error) { RecordingEditor.xml('<!DOCTYPE recording [<!ENTITY x SYSTEM "file:///etc/passwd">]><recording>&x;</recording>') }
  end

  def test_assets_include_missing_warning_without_guessing_file_times
    data = @repo.recording(@id).to_h
    assert_equal 2, data[:assets].size
    assert data[:warnings].any? { |w| w.include?('素材がありません') }
    assert_equal '編集テスト & meeting', data[:name]
  end

  def test_beep_censors_mic_and_shared_audio_preserving_originals_and_video
    sources
    originals = %w[audio/microphone.wav deskshare/screen.mp4].to_h { |p| [p, Digest::SHA256.file(File.join(@raw, p)).hexdigest] }
    rec = @repo.recording(@id)
    result = RecordingEditor::Editor.new(@repo).save(@id, payload(rec, [{ 'start_ms' => 2000, 'end_ms' => 4000 }]))
    assert_equal 2, result['outputs'].size
    outputs = result['outputs'].to_h { |o| [o[:source], File.join(@raw, o[:relative])] }
    originals.each do |path, hash|
      assert_equal hash, Digest::SHA256.file(File.join(@raw, path)).hexdigest
      assert File.file?(File.join(@repo.state_dir(@id), 'original-media', path))
    end
    assert_in_delta 0.085, rms(samples(outputs['audio/microphone.wav'], 2.5)), 0.015
    assert_operator rms(samples(outputs['deskshare/screen.mp4'], 1.5)), :<, 0.003
    assert_operator rms(samples(outputs['deskshare/screen.mp4'], 0.2)), :>, 0.04
    assert_operator rms(samples(outputs['deskshare/screen.mp4'], 3.3)), :>, 0.04
    assert_operator rms(samples(outputs['audio/microphone.wav'], 4.5)), :>, 0.04
    old_video = RecordingEditor.run('ffmpeg', '-v', 'error', '-i', File.join(@raw, 'deskshare/screen.mp4'), '-map', '0:v', '-c:v', 'copy', '-f', 'framemd5', '-')
    new_video = RecordingEditor.run('ffmpeg', '-v', 'error', '-i', outputs['deskshare/screen.mp4'], '-map', '0:v', '-c:v', 'copy', '-f', 'framemd5', '-')
    assert_equal old_video, new_video
    current = @repo.recording(@id).current_doc
    start = current.at_xpath('/recording/event[@eventname="StartRecordingEvent"]/filename').text
    stop = current.at_xpath('/recording/event[@eventname="StopRecordingEvent"]/filename').text
    assert_equal start, stop
    assert_match(/bbb-editor-/, start)
    # Removing the censor returns references to the original data.
    RecordingEditor::Editor.new(@repo).save(@id, payload(@repo.recording(@id), []))
    restored = @repo.recording(@id).current_doc.at_xpath('/recording/event[@eventname="StartRecordingEvent"]/filename').text
    assert_equal '/server/audio/microphone.wav', restored
  end

  def test_preview_has_full_meeting_duration_and_waveform
    sources
    rec = @repo.recording(@id)
    key = rec.to_h[:preview_key]
    result = RecordingEditor::Media.new(rec).preview(key)
    assert_equal 2048, result[:peaks].size
    file = File.join(@repo.state_dir(@id), 'preview', key, 'audio.webm')
    assert_in_delta 6, @repo.probe(file).dig('format', 'duration').to_f, 0.05
    assert_operator rms(samples(file, 0.2)), :>, 0.04
    assert_equal result, RecordingEditor::Media.new(rec).preview(key)
  end

  def test_preview_with_late_timestamp_gap_preserves_clock
    source = timestamp_gap_source
    original = Digest::SHA256.file(source).hexdigest
    xml_before = File.binread(File.join(@raw, 'events.xml'))
    rec = @repo.recording(@id)
    key = rec.to_h[:preview_key]
    result = RecordingEditor::Media.new(rec).preview(key)
    file = File.join(@repo.state_dir(@id), 'preview', key, 'audio.webm')
    assert_in_delta 14, @repo.probe(file).dig('format', 'duration').to_f, 0.05
    assert_operator rms(samples(file, 0.1)), :<, 0.003
    assert_tone_at(file, 2, 440)
    assert_tone_at(file, 5, 880)
    assert_tone_at(file, 9, 1320)
    assert_tone_at(file, 12, 1320)
    assert_operator rms(samples(file, 13.5)), :<, 0.003
    assert_equal 2048, result[:peaks].size
    assert_operator result[:peaks][(9.0 / 14 * 2048).to_i], :>, 0.03
    assert_equal original, Digest::SHA256.file(source).hexdigest
    assert_equal xml_before, File.binread(File.join(@raw, 'events.xml'))
  end

  def test_preview_does_not_reuse_the_old_clock_cache
    # No media files are needed to check the v2-to-v3 cache migration.
    rec = @repo.recording(@id)
    old_key = Digest::SHA256.hexdigest(['preview-clock-v2', rec.revision].join('|'))[0, 24]
    old_dir = File.join(@repo.state_dir(@id), 'preview', old_key)
    FileUtils.mkdir_p(old_dir)
    File.write(File.join(old_dir, 'audio.webm'), 'old broken preview')
    File.write(File.join(old_dir, 'peaks.json'), '[0]')
    key = rec.to_h[:preview_key]
    refute_equal old_key, key
    result = RecordingEditor::Media.new(rec).preview(key)
    file = File.join(@repo.state_dir(@id), 'preview', key, 'audio.webm')
    assert_in_delta 6, @repo.probe(file).dig('format', 'duration').to_f, 0.05
    assert_equal 2048, result[:peaks].size
    assert_equal 'old broken preview', File.read(File.join(old_dir, 'audio.webm'))
    assert_equal @events, File.read(File.join(@raw, 'events.xml'))
  end

  def test_beep_save_with_late_timestamp_gap_preserves_duration_and_later_audio
    source = timestamp_gap_source
    original = Digest::SHA256.file(source).hexdigest
    rec = @repo.recording(@id)
    data = { 'revision' => rec.revision, 'record_ranges' => rec.record_ranges,
             'beep_ranges' => [{ 'start_ms' => 6500, 'end_ms' => 7500 }] }
    result = RecordingEditor::Editor.new(@repo).save(@id, data)
    file = File.join(@raw, result['outputs'].first[:relative])
    assert_in_delta @repo.probe(source).dig('format', 'duration').to_f,
                    @repo.probe(file).dig('format', 'duration').to_f, 0.05
    # Non-monotonic PTS can hide extra silence from format duration and seeks.
    # Check the actual decoded sample count during continuous playback too.
    decoded = RecordingEditor.run('ffmpeg', '-nostdin', '-v', 'error', '-i', file,
      '-ac', '1', '-ar', '8000', '-f', 'f32le', '-')
    assert_in_delta @repo.probe(source).dig('format', 'duration').to_f, decoded.bytesize / 32_000.0, 0.05
    assert_tone_at(file, 2, 440)
    assert_tone_at(file, 4.5, 880)
    assert_tone_at(file, 6.25, 1000)
    assert_tone_at(file, 8.5, 1320)
    assert_tone_at(file, 11.5, 1320)
    assert_equal original, Digest::SHA256.file(source).hexdigest
  end

  def test_reopening_restores_beeps_and_resaving_uses_original_sources
    sources
    editor = RecordingEditor::Editor.new(@repo)
    first = [{ 'start_ms' => 2000, 'end_ms' => 3000 }]
    editor.save(@id, payload(@repo.recording(@id), first))
    reopened = @repo.recording(@id)
    assert_equal first, reopened.to_h[:beep_ranges]
    assert_equal 'audio/microphone.wav', reopened.assets.first['relative']
    combined = first + [{ 'start_ms' => 4000, 'end_ms' => 5000 }]
    result = editor.save(@id, payload(reopened, combined))
    mic = result['outputs'].find { |item| item[:source] == 'audio/microphone.wav' }
    assert_in_delta 0.085, rms(samples(File.join(@raw, mic[:relative]), 2.5)), 0.015
    assert_in_delta 0.085, rms(samples(File.join(@raw, mic[:relative]), 4.5)), 0.015
    # Removing the old interval must recover speech there, without retaining its beep.
    result = editor.save(@id, payload(@repo.recording(@id), combined.last(1)))
    mic = result['outputs'].find { |item| item[:source] == 'audio/microphone.wav' }
    assert_in_delta rms(samples(File.join(@raw, 'audio/microphone.wav'), 2.5)), rms(samples(File.join(@raw, mic[:relative]), 2.5)), 0.001
  end

  def test_reset_restores_exact_xml_and_media_and_archives_edits
    sources
    editor = RecordingEditor::Editor.new(@repo)
    original_mic = File.binread(File.join(@raw, 'audio/microphone.wav'))
    original_screen = File.binread(File.join(@raw, 'deskshare/screen.mp4'))
    saved = editor.save(@id, payload(@repo.recording(@id), [{ 'start_ms' => 2000, 'end_ms' => 4000 }]))
    assert_equal @events.b, File.binread(File.join(@repo.state_dir(@id), 'original-events.xml'))
    editor.draft(@id, payload(@repo.recording(@id)))
    before = File.binread(File.join(@raw, 'events.xml'))
    # Missing/externally altered originals are recoverable from the snapshot.
    File.binwrite(File.join(@raw, 'audio/microphone.wav'), 'damaged original')
    FileUtils.rm_f(File.join(@raw, 'deskshare/screen.mp4'))
    result = editor.reset(@id, { 'revision' => saved['revision'], 'confirmed' => true })
    assert_equal @events.b, File.binread(File.join(@raw, 'events.xml'))
    assert_equal original_mic, File.binread(File.join(@raw, 'audio/microphone.wav'))
    assert_equal original_screen, File.binread(File.join(@raw, 'deskshare/screen.mp4'))
    assert_equal before, File.binread(result['xml_backup'])
    assert File.file?(File.join(result['archive'], 'draft.json'))
    refute File.exist?(File.join(@repo.state_dir(@id), 'draft.json'))
    saved['outputs'].each do |item|
      refute File.exist?(File.join(@raw, item[:relative]))
      assert File.file?(File.join(result['archive'], 'media', item[:relative]))
    end
    reopened = @repo.recording(@id)
    assert_equal [], reopened.to_h[:beep_ranges]
    assert_equal [{ 'start_ms' => 1000, 'end_ms' => 5000 }], reopened.record_ranges
    editor.save(@id, payload(reopened))
    editor.reset(@id, { 'revision' => @repo.recording(@id).revision, 'confirmed' => true })
    assert_equal @events.b, File.binread(File.join(@raw, 'events.xml'))
  end

  def test_reset_can_restore_original_xml_without_recording_marks
    xml = RecordingEditor.xml(@events)
    xml.xpath('/recording/event[@eventname="RecordStatusEvent"]').each(&:remove)
    original = xml.to_xml
    File.binwrite(File.join(@raw, 'events.xml'), original)
    editor = RecordingEditor::Editor.new(@repo)
    assert_empty @repo.recording(@id).to_h[:record_ranges]
    saved = editor.save(@id, payload)
    refute_empty @repo.recording(@id).to_h[:record_ranges]
    editor.reset(@id, { 'revision' => saved['revision'], 'confirmed' => true })
    assert_equal original.b, File.binread(File.join(@raw, 'events.xml'))
    assert_empty @repo.recording(@id).current_doc.xpath('/recording/event[@eventname="RecordStatusEvent"]')
    manifest = @repo.recording(@id).to_h
    assert_empty manifest[:record_ranges]
    assert_empty manifest[:original_record_ranges]
    refute manifest[:record_ranges_persisted]
    assert_raises(RecordingEditor::Error) { editor.rebuild(@id, { 'revision' => @repo.recording(@id).revision, 'confirmed' => true }) }
  end

  def test_reset_preflight_rejects_corrupt_backups_and_unconfirmed_or_stale_requests
    sources
    editor = RecordingEditor::Editor.new(@repo)
    saved = editor.save(@id, payload)
    before = File.binread(File.join(@raw, 'events.xml'))
    assert_raises(RecordingEditor::Error) { editor.reset(@id, { 'revision' => saved['revision'] }) }
    assert_raises(RecordingEditor::Error) { editor.reset(@id, { 'revision' => 'stale', 'confirmed' => true }) }
    File.binwrite(File.join(@repo.state_dir(@id), 'original-media/audio/microphone.wav'), 'corrupt')
    assert_raises(RecordingEditor::Error) { editor.reset(@id, { 'revision' => saved['revision'], 'confirmed' => true }) }
    assert_equal before, File.binread(File.join(@raw, 'events.xml'))
    assert_equal saved['revision'], @repo.recording(@id).history_data['revision']
  end

  def test_reset_rolls_back_xml_settings_draft_and_media_on_commit_failure
    sources
    editor = RecordingEditor::Editor.new(@repo)
    saved = editor.save(@id, payload(@repo.recording(@id), [{ 'start_ms' => 2000, 'end_ms' => 4000 }]))
    editor.draft(@id, payload(@repo.recording(@id)))
    before = File.binread(File.join(@raw, 'events.xml'))
    saved_path = File.join(@repo.state_dir(@id), 'saved.json')
    altered = File.join(@raw, 'audio/microphone.wav')
    File.binwrite(altered, 'external alteration before reset')
    write = RecordingEditor.method(:atomic_write)
    fail_once = true
    RecordingEditor.stub(:atomic_write, lambda { |path, data, **opts|
      if path == saved_path && fail_once
        fail_once = false
        raise IOError, 'simulated state write failure'
      end
      write.call(path, data, **opts)
    }) do
      assert_raises(IOError) { editor.reset(@id, { 'revision' => saved['revision'], 'confirmed' => true }) }
    end
    assert_equal before, File.binread(File.join(@raw, 'events.xml'))
    assert_equal saved['revision'], @repo.recording(@id).history_data['revision']
    assert File.file?(File.join(@repo.state_dir(@id), 'draft.json'))
    assert_equal 'external alteration before reset', File.binread(altered)
    saved['outputs'].each { |item| assert File.file?(File.join(@raw, item[:relative])) }
  end

  def test_legacy_reset_recovers_exact_xml_from_matching_backup
    editor = RecordingEditor::Editor.new(@repo)
    saved = editor.save(@id, payload)
    root = @repo.state_dir(@id)
    FileUtils.rm_f(File.join(root, 'original.json'))
    File.binwrite(File.join(root, 'original-events.xml'), RecordingEditor.xml(@events).to_xml)
    assert @repo.recording(@id).to_h[:reset][:available]
    editor.reset(@id, { 'revision' => saved['revision'], 'confirmed' => true })
    assert_equal @events.b, File.binread(File.join(@raw, 'events.xml'))
  end

  def test_legacy_without_original_xml_backup_remains_editable_but_cannot_reset
    editor = RecordingEditor::Editor.new(@repo)
    editor.save(@id, payload)
    root = @repo.state_dir(@id)
    FileUtils.rm_f(File.join(root, 'original.json'))
    File.binwrite(File.join(root, 'original-events.xml'), RecordingEditor.xml(@events).to_xml)
    Dir.glob(File.join(@raw, 'events.xml.bak.*')).each { |path| FileUtils.rm_f(path) }
    refute @repo.recording(@id).to_h[:reset][:available]
    saved = editor.save(@id, payload)
    assert_raises(RecordingEditor::Error) { editor.reset(@id, { 'revision' => saved['revision'], 'confirmed' => true }) }
    refute File.exist?(File.join(root, 'original.json'))
    assert_equal saved['revision'], @repo.recording(@id).revision
  end

  def test_preview_with_silent_meeting_tail_finishes_and_preserves_timing
    skip 'GNU timeout is required for this termination regression test' unless system('timeout', '--version', out: File::NULL, err: File::NULL)
    # Cover ordinary Opus and the legacy WAV time-stretch path separately.
    [['webm', 'libopus', 3.5], ['wav', 'pcm_s16le', 3.43]].each do |extension, codec, length|
      filename = "microphone.#{extension}"
      RecordingEditor.run('ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', "sine=frequency=440:duration=#{length}", '-ac', '2', '-c:a', codec, File.join(@raw, 'audio', filename))
      xml = RecordingEditor.xml(@events.gsub('microphone.wav', filename))
      xml.xpath('/recording/event[@eventname="StartWebRTCDesktopShareEvent" or @eventname="StopWebRTCDesktopShareEvent"]').each(&:remove)
      xml.at_xpath('/recording/event[@eventname="StartRecordingEvent"]')['timestamp'] = (@origin + 2500).to_s
      ending = xml.at_xpath('/recording/event[@eventname="EndAndKickAllEvent"]')
      ending['timestamp'] = (@origin + 10_000).to_s
      ending.at_xpath('timestampUTC').content = (@utc + 10_000).to_s
      File.write(File.join(@raw, 'events.xml'), xml.to_xml)
      rec = @repo.recording(@id)
      key = rec.to_h[:preview_key]
      # The old Opus chain hangs even with a short silent tail. Kill the
      # actual FFmpeg command on regression instead of leaving a test running.
      run = RecordingEditor.method(:run)
      result = RecordingEditor.stub(:run, ->(*args) { run.call('timeout', '10s', *args) }) do
        RecordingEditor::Media.new(rec).preview(key)
      end
      file = File.join(@repo.state_dir(@id), 'preview', key, 'audio.webm')
      assert_in_delta 10, @repo.probe(file).dig('format', 'duration').to_f, 0.05
      assert_operator rms(samples(file, 0.2)), :<, 0.003
      assert_operator rms(samples(file, 2.8)), :>, 0.04
      assert_operator rms(samples(file, 7.5)), :<, 0.003
      assert_equal 2048, result[:peaks].size
    end
  end

  def test_preview_preserves_embedded_audio_delay_and_event_offset
    sources
    screen = File.join(@raw, 'deskshare', 'screen.mp4')
    RecordingEditor.run('ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=5:d=4', '-itsoffset', '0.3', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=3.7', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', screen)
    xml = RecordingEditor.xml(@events)
    xml.xpath('/recording/event[@module="VOICE"]').each(&:remove)
    File.write(File.join(@raw, 'events.xml'), xml.to_xml)
    rec = @repo.recording(@id)
    key = rec.to_h[:preview_key]
    RecordingEditor::Media.new(rec).preview(key)
    file = File.join(@repo.state_dir(@id), 'preview', key, 'audio.webm')
    assert_in_delta 6, @repo.probe(file).dig('format', 'duration').to_f, 0.05
    assert_operator rms(samples(file, 1.05, 0.1)), :<, 0.003
    assert_operator rms(samples(file, 1.5)), :>, 0.04
    assert_operator rms(samples(file, 5.5)), :<, 0.003
  end

  def test_livekit_individual_tracks_and_three_zero_events
    xml = @events.gsub('bbb_version="4.0.0"', 'bbb_version="3.0.0"')
    xml = xml.gsub('module="VOICE" eventname="StartRecordingEvent"', 'module="bbb-webrtc-sfu" eventname="AudioTrackPublishedEvent"')
    xml = xml.gsub('module="VOICE" eventname="StopRecordingEvent"', 'module="bbb-webrtc-sfu" eventname="AudioTrackUnpublishedEvent"')
    File.write(File.join(@raw, 'events.xml'), xml)
    sources
    rec = @repo.recording(@id)
    assert_equal 2, rec.audible_assets.size
    assert_equal 0, rec.audible_assets.first['start_ms']
    result = RecordingEditor::Editor.new(@repo).save(@id, payload(rec, [{ 'start_ms' => 2000, 'end_ms' => 2500 }]))
    assert_equal 2, result['outputs'].size
    assert @repo.recording(@id).current_doc.at_xpath('/recording/event[@eventname="AudioTrackPublishedEvent"]/filename').text.include?('bbb-editor-')
  end
  def test_stereo_opus_uses_sample_time_censorship
    sources
    FileUtils.rm_f(File.join(@raw, 'audio', 'microphone.wav'))
    path = File.join(@raw, 'audio', 'microphone.webm')
    RecordingEditor.run('ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-ac', '2', '-ar', '48000', '-c:a', 'libopus', path)
    File.write(File.join(@raw, 'events.xml'), @events.gsub('microphone.wav', 'microphone.webm'))
    rec = @repo.recording(@id)
    result = RecordingEditor::Editor.new(@repo).save(@id, payload(rec, [{ 'start_ms' => 2000, 'end_ms' => 4000 }]))
    output = File.join(@raw, result['outputs'].first[:relative])
    2.times do |channel|
      values = RecordingEditor.run('ffmpeg', '-nostdin', '-v', 'error', '-ss', '2.5', '-i', output, '-t', '0.2', '-af', "pan=mono|c0=c#{channel}", '-ar', '16000', '-f', 'f32le', '-').unpack('e*')
      assert_in_delta 0.085, rms(values), 0.02
    end
    assert_operator rms(samples(output, 1)), :>, 0.04
    assert_equal 2, @repo.probe(output)['streams'].first['channels']
  end

  def test_raw_slide_and_tldraw_page_numbers_are_zero_based
    xml = @events.sub('</recording>', '<event timestamp="8000002700" module="PRESENTATION" eventname="AddTldrawShapeEvent"><presentation>slides</presentation><pageNumber>2</pageNumber><shapeId>shape:a</shapeId><shapeData>{"id":"shape:a"}</shapeData></event></recording>')
    File.write(File.join(@raw, 'events.xml'), xml)
    slide_dir = File.join(@raw, 'presentation', 'slides', 'svgs')
    FileUtils.mkdir_p(slide_dir)
    File.write(File.join(slide_dir, 'slide3.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="1080"/>')
    manifest = @repo.recording(@id).to_h
    assert_equal [3, 3], manifest[:events].select { |e| %w[GotoSlideEvent AddTldrawShapeEvent].include?(e['type']) }.map { |e| e['page'] }
    assert_equal 3, manifest[:slides].first['page']
  end

  def test_beep_refuses_missing_sources_or_unknown_audio_timing
    data = payload(@repo.recording(@id), [{ 'start_ms' => 2000, 'end_ms' => 4000 }])
    assert_raises(RecordingEditor::Error) { RecordingEditor::Editor.new(@repo).save(@id, data) }
    assert_equal @events, File.read(File.join(@raw, 'events.xml'))
    sources
    FileUtils.copy_file(File.join(@raw, 'audio', 'microphone.wav'), File.join(@raw, 'audio', 'untracked.wav'))
    assert_raises(RecordingEditor::Error) { RecordingEditor::Editor.new(@repo).save(@id, data) }
    assert_equal @events, File.read(File.join(@raw, 'events.xml'))
  end

  def test_shared_audio_initial_offset_is_preserved
    sources
    screen = File.join(@raw, 'deskshare', 'screen.mp4')
    RecordingEditor.run('ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=5:d=4', '-itsoffset', '0.3', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=3.7', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', screen)
    rec = @repo.recording(@id)
    result = RecordingEditor::Editor.new(@repo).save(@id, payload(rec, [{ 'start_ms' => 2000, 'end_ms' => 4000 }]))
    output = File.join(@raw, result['outputs'].find { |o| o[:source] == 'deskshare/screen.mp4' }[:relative])
    assert_operator rms(samples(output, 0.05, 0.1)), :<, 0.003
    assert_operator rms(samples(output, 0.5)), :>, 0.04
    assert_operator rms(samples(output, 1.5)), :<, 0.003
  end

end
