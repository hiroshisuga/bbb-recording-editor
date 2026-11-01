# frozen_string_literal: true
require 'minitest/autorun'
require 'minitest/mock'
require 'tmpdir'
require_relative '../lib/recording_editor'

class AudioRenderTest < Minitest::Test
  def setup
    @dir = Dir.mktmpdir('bbb-audio-reuse-')
    @id = "#{'e' * 40}-1700000000000"
    @options = { raw_root: File.join(@dir, 'raw'), state_root: File.join(@dir, 'state') }
    @repo = RecordingEditor::Repository.new(**@options)
    @raw = File.join(@repo.raw_root, @id)
    FileUtils.mkdir_p(File.join(@raw, 'audio'))
    File.write(File.join(@raw, 'events.xml'), '<recording><event timestamp="1000" module="VOICE" eventname="StartRecordingEvent"><filename>mic.wav</filename></event><event timestamp="7000" module="VOICE" eventname="StopRecordingEvent"><filename>mic.wav</filename></event></recording>')
    RecordingEditor.run('ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', File.join(@raw, 'audio/mic.wav'))
    @records = [{ 'start_ms' => 500, 'end_ms' => 2500 }, { 'start_ms' => 3500, 'end_ms' => 6000 }]
    @beeps = [{ 'start_ms' => 1000, 'end_ms' => 1500 }]
  end

  def teardown
    FileUtils.remove_entry(@dir)
  end

  def save(records: @records, beeps: @beeps, chime: true, sound: 'a')
    RecordingEditor::Editor.new(@repo).save(@id, {
      'revision' => @repo.recording(@id).revision, 'record_ranges' => records,
      'beep_ranges' => beeps, 'cut_chime' => chime, 'cut_chime_sound' => sound })
  end

  def encodes
    calls = []
    runner = RecordingEditor.method(:run)
    RecordingEditor.stub(:run, lambda { |*args| calls << args if args.first == 'ffmpeg'; runner.call(*args) }) { yield }
    calls
  end

  def paths(result)
    result['outputs'].map { |o| o[:relative] }
  end

  def test_reuses_verified_media_after_reopening_and_for_keep_only_changes
    first = save
    @repo = RecordingEditor::Repository.new(**@options) # Persist across app restart.
    records = @records.map(&:dup)
    records[0]['start_ms'] = 800
    second = nil
    assert_empty encodes { second = save(records: records) }
    assert_equal paths(first), paths(second)
    assert_equal records, @repo.recording(@id).record_ranges
    assert_equal first['audio_render'], second['audio_render']
    assert_equal 2, Dir.glob(File.join(@repo.state_dir(@id), 'edit-*.json')).size
    assert_equal 2, @repo.recording(@id).current_doc.xpath('/recording/event[@eventname="AudioTrackPublishedEvent"][starts-with(filename,"bbb-editor-cue-")]').size
    first['audio_render']['files'].each do |f|
      assert_equal f['sha256'], Digest::SHA256.file(File.join(@raw, f['relative'])).hexdigest
    end
    reset = RecordingEditor::Editor.new(@repo).reset(@id, { 'revision' => second['revision'], 'confirmed' => true })
    paths(first).each do |relative|
      refute File.exist?(File.join(@raw, relative))
      assert File.file?(File.join(reset['archive'], 'media', relative))
    end
  end

  def test_unchanged_save_and_save_without_audio_edits_need_no_encoder
    first = save
    assert_empty encodes { assert_equal paths(first), paths(save) }
    cleared = save(beeps: [], chime: false)
    assert_empty cleared['outputs']
    assert_empty encodes { assert_empty save(beeps: [], chime: false)['outputs'] }
    assert_equal 'mic.wav', @repo.recording(@id).current_doc.at_xpath('/recording/event/filename').text
  end

  def test_changing_only_sound_reuses_long_media_and_renders_the_selected_pcm_halves
    first = save
    media = first['outputs'].reject { |o| o[:cue] }.map { |o| o[:relative] }
    %w[c tape].each do |sound|
      result = nil
      calls = encodes { result = save(sound: sound) }
      assert calls.all? { |args| args.include?(RecordingEditor::CutChime.sample(sound)) }
      assert_equal media, result['outputs'].reject { |o| o[:cue] }.map { |o| o[:relative] }
      decode = ->(path) { RecordingEditor.run('ffmpeg', '-v', 'error', '-i', path, '-f', 's16le', '-') }
      cues = result['outputs'].select { |o| o[:cue] }.sort_by { |o| o[:cue]['start_ms'] }
      assert_equal decode.call(RecordingEditor::CutChime.sample(sound)), cues.map { |o| decode.call(File.join(@raw, o[:relative])) }.join
      assert_equal sound, result['cut_chime_sound']
      assert_equal sound, @repo.recording(@id).to_h[:cut_chime_sound]
      assert_empty encodes { save(sound: sound) }
    end
    editor = RecordingEditor::Editor.new(@repo)
    input = { 'revision' => @repo.recording(@id).revision, 'record_ranges' => @records,
              'beep_ranges' => @beeps, 'cut_chime' => true, 'cut_chime_sound' => 'c' }
    assert_equal 'c', editor.draft(@id, input)[:cut_chime_sound]
    editor.reset(@id, { 'revision' => @repo.recording(@id).revision, 'confirmed' => true })
    assert_equal 'a', @repo.recording(@id).to_h[:cut_chime_sound]
  end

  def test_previous_single_sound_cache_can_reuse_media_when_a_new_sound_is_selected
    first = save
    history_path = File.join(@repo.state_dir(@id), 'saved.json')
    history = JSON.parse(File.read(history_path))
    renderer = RecordingEditor::AudioRender.new(@repo.recording(@id))
    cues = RecordingEditor::CutChime.cues(RecordingEditor::CutChime.gaps(@records))
    history['audio_render']['key'] = renderer.fingerprint(@beeps, cues, legacy: true)
    history['audio_render'].delete('media_key')
    history.delete('cut_chime_sound')
    File.write(history_path, JSON.generate(history))
    second = nil
    calls = encodes { second = save(sound: 'c') }
    assert calls.all? { |args| args.include?(RecordingEditor::CutChime.sample('c')) }
    assert_equal first['outputs'].first[:relative], second['outputs'].first[:relative]
  end

  def test_invalid_sound_does_not_change_raw_or_create_a_save
    bytes = File.binread(File.join(@raw, 'events.xml'))
    assert_raises(RecordingEditor::Error) { save(sound: '../outside') }
    assert_equal bytes, File.binread(File.join(@raw, 'events.xml'))
    assert_empty Dir.glob(File.join(@repo.state_dir(@id), 'edit-*.json'))
  end

  def test_changed_beep_or_chime_regenerates_from_original_and_preserves_old_files
    first = save
    second = nil
    refute_empty encodes { second = save(beeps: [{ 'start_ms' => 2000, 'end_ms' => 2200 }]) }
    refute_equal paths(first), paths(second)
    third = nil
    refute_empty encodes { third = save(chime: false) }
    assert_equal 1, third['outputs'].size
    paths(first).each { |relative| assert File.file?(File.join(@raw, relative)) }
    backup = File.join(@repo.state_dir(@id), 'original-media/audio/mic.wav')
    assert_equal Digest::SHA256.file(backup).hexdigest, Digest::SHA256.file(File.join(@raw, 'audio/mic.wav')).hexdigest
  end

  def test_moving_chime_boundaries_invalidates_cached_audio
    first = save
    moved = @records.map(&:dup)
    moved[0]['end_ms'] -= 100
    second = nil
    refute_empty encodes { second = save(records: moved) }
    refute_equal first['audio_render']['key'], second['audio_render']['key']
  end

  def test_missing_and_same_size_corrupted_outputs_are_regenerated
    first = save
    File.unlink(File.join(@raw, paths(first).last))
    second = nil
    refute_empty encodes { second = save }
    corrupt = File.join(@raw, paths(second).first)
    bytes = File.binread(corrupt)
    bytes.setbyte(bytes.length - 1, bytes.getbyte(bytes.length - 1) ^ 1)
    File.binwrite(corrupt, bytes)
    third = nil
    refute_empty encodes { third = save }
    refute_equal paths(second), paths(third)
  end

  def test_source_changes_and_legacy_saves_invalidate_cache
    save
    source = File.join(@raw, 'audio/mic.wav')
    time = Time.now + 2
    File.utime(time, time, source)
    refute_empty encodes { save }
    history = File.join(@repo.state_dir(@id), 'saved.json')
    data = JSON.parse(File.read(history))
    data.delete('audio_render')
    File.write(history, JSON.generate(data))
    refute_empty encodes { save }
    assert_empty encodes { save }
  end
end
