# frozen_string_literal: true
require 'minitest/autorun'
require 'minitest/mock'
require 'tmpdir'
require_relative '../lib/recording_editor'

class DetailWaveformTest < Minitest::Test
  def setup
    @dir = Dir.mktmpdir('bbb-detail-wave-')
    @id = "#{'c' * 40}-1700000000000"
    @key = 'a' * 24
    @repo = RecordingEditor::Repository.new(raw_root: File.join(@dir, 'raw'), state_root: File.join(@dir, 'state'))
    @dir_preview = File.join(@repo.state_dir(@id), 'preview', @key)
    FileUtils.mkdir_p(@dir_preview)
    @audio = File.join(@dir_preview, 'audio.webm')
    @wave = @repo.detail_waveform
  end

  def teardown
    FileUtils.remove_entry(@dir)
  end

  def source
    # Known 300ms silence inside a late chunk, and a partial final chunk.
    signal = "aevalsrc='if(between(t,12,12.3),0,0.2*sin(2*PI*440*t))':s=48000:d=24.25"
    RecordingEditor.run('ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', signal, '-c:a', 'libopus', @audio)
  end

  def test_only_requested_chunk_is_decoded_with_signed_peaks_and_precise_silence
    source
    before = Digest::SHA256.file(@audio).hexdigest
    assert_empty Dir.glob(File.join(@dir_preview, 'waveform-*', '*.json'))
    result = @wave.chunk(@id, @key, 1)
    assert_equal 10000, result[:start_ms]
    assert_equal 10, result[:step_ms]
    assert_equal 1000, result[:min].size
    assert_operator result[:min][100], :<, -0.15
    assert_operator result[:max][100], :>, 0.15
    (210..220).each do |i|
      assert_operator result[:min][i].abs, :<, 0.001
      assert_operator result[:max][i].abs, :<, 0.001
    end
    assert_equal ['1.json'], Dir.glob(File.join(@dir_preview, 'waveform-v1', '*.json')).map { |f| File.basename(f) }
    assert_equal before, Digest::SHA256.file(@audio).hexdigest
    @wave.stub(:decode, ->(*) { flunk 'Cached chunks must not decode again' }) do
      assert_equal result, @wave.chunk(@id, @key, 1).transform_keys(&:to_sym)
    end
    tail = @wave.chunk(@id, @key, 2)
    assert_includes 425..426, tail[:min].size
    assert_equal 416, assert_raises(RecordingEditor::Error) { @wave.chunk(@id, @key, 3) }.status
    refute File.exist?(File.join(@dir_preview, 'waveform-v1', '3.json'))
  end

  def test_late_opus_seek_stays_within_one_thousand_bins
    source
    looped = File.join(@dir_preview, 'loop.webm')
    RecordingEditor.run('ffmpeg', '-nostdin', '-v', 'error', '-y', '-stream_loop', '7', '-i', @audio,
      '-t', '180', '-c', 'copy', looped)
    FileUtils.mv(looped, @audio)
    [4, 13, 17].each do |index|
      result = @wave.chunk(@id, @key, index)
      assert_equal index * 10000, result[:start_ms]
      assert_equal 1000, result[:min].size
      assert_operator result[:max].max, :>, 0.15
    end
  end

  def test_cache_identity_changes_with_preview_and_never_requires_reparsing_events
    source
    @wave.chunk(@id, @key, 0)
    other_key = 'b' * 24
    other_dir = File.join(@repo.state_dir(@id), 'preview', other_key)
    FileUtils.mkdir_p(other_dir); FileUtils.cp(@audio, File.join(other_dir, 'audio.webm'))
    calls = []
    @wave.stub(:decode, ->(audio, start) { calls << [audio, start]; Array.new(80, 0.0).pack('e*') }) do
      @wave.chunk(@id, @key, 0)
      @wave.chunk(@id, other_key, 0)
    end
    assert_equal [[File.join(other_dir, 'audio.webm'), 0]], calls
    refute File.exist?(File.join(@repo.state_dir(@id), 'preview', other_key, 'peaks.json'))
  end

  def test_bounds_missing_preview_and_decoder_failure_do_not_leave_cache_or_slots
    assert_equal 404, assert_raises(RecordingEditor::Error) { @wave.chunk(@id, @key, 0) }.status
    File.write(@audio, 'not audio')
    assert_raises(RecordingEditor::Error) { @wave.chunk(@id, '../bad', 0) }
    assert_raises(RecordingEditor::Error) { @wave.chunk(@id, @key, -1) }
    assert_raises(RecordingEditor::Error) { @wave.chunk(@id, @key, 1_000_000) }
    assert_equal 422, assert_raises(RecordingEditor::Error) { @wave.chunk(@id, @key, 0) }.status
    assert_empty Dir.glob(File.join(@dir_preview, 'waveform-*', '*.json'))
    assert_empty @wave.instance_variable_get(:@active)
  end

  def test_timeout_releases_decoder_capacity_without_leaving_a_cache_file
    source
    Timeout.stub(:timeout, ->(*) { raise Timeout::Error }) do
      assert_equal 503, assert_raises(RecordingEditor::Error) { @wave.chunk(@id, @key, 0) }.status
    end
    assert_empty @wave.instance_variable_get(:@active)
    assert_empty Dir.glob(File.join(@dir_preview, 'waveform-*', '*.json'))
    assert_equal 1000, @wave.chunk(@id, @key, 0)[:min].size
  end

  def test_two_decoders_maximum_duplicate_requests_retry_and_cache_hits_are_immediate
    File.write(@audio, 'stubbed')
    ready, release = Queue.new, Queue.new
    threads = []
    @wave.stub(:decode, ->(*) { ready << true; release.pop; Array.new(80, 0.0).pack('e*') }) do
      threads = [1, 2].map { |i| Thread.new { @wave.chunk(@id, @key, i) } }
      2.times { ready.pop }
      assert_equal 429, assert_raises(RecordingEditor::Error) { @wave.chunk(@id, @key, 1) }.status
      assert_equal 429, assert_raises(RecordingEditor::Error) { @wave.chunk(@id, @key, 3) }.status
      2.times { release << true }
      threads.each(&:value)
    end
    assert_empty @wave.instance_variable_get(:@active)
    assert_equal 10000, @wave.chunk(@id, @key, 1)['start_ms']
  ensure
    threads.each(&:kill)
  end
end
