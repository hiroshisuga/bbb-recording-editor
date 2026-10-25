# frozen_string_literal: true

require 'timeout'

module RecordingEditor
  # Short, seeked reads of the existing event-clock preview. Never scans the
  # meeting or joins the save/rebuild queue. One speculative neighbor at most
  # is requested by the client; two decoders bound aggregate server load.
  class DetailWaveform
    CHUNK_MS = 10_000
    STEP_MS = 10
    RATE = 8000
    SAMPLES_PER_BIN = RATE * STEP_MS / 1000

    def initialize(repo)
      @repo, @mutex, @active = repo, Mutex.new, {}
    end

    def chunk(id, key, index)
      @repo.check_id(id)
      raise Error, 'プレビュー識別子が不正です。' unless key.match?(/\A[a-f0-9]{24}\z/)
      raise Error, '波形の区間が不正です。' unless index.is_a?(Integer) && index.between?(0, 999_999)
      dir = File.join(@repo.state_dir(id), 'preview', key)
      audio = File.join(dir, 'audio.webm')
      raise Error.new('プレビュー音声の準備が必要です。', 404) unless File.file?(audio)
      cache = File.join(dir, 'waveform-v1', "#{index}.json")
      return JSON.parse(File.read(cache)) if File.file?(cache)
      identity = [id, key, index]
      acquired = @mutex.synchronize do
        next false if @active.size >= 2 || @active[identity]
        @active[identity] = true
      end
      raise Error.new('詳細波形を処理中です。少し待って再試行してください。', 429) unless acquired
      begin
        # Input-side accurate seeking uses WebM cues, including late positions.
        # Decode only this chunk; never decode the prefix up to the playhead.
        pcm = decode(audio, index * CHUNK_MS)
        raise Error.new('音声の範囲外です。', 416) if pcm.empty?
        low, high = [], []
        pcm.unpack('e*').each_slice(SAMPLES_PER_BIN) do |samples|
          low << samples.min.round(5)
          high << samples.max.round(5)
        end
        result = { start_ms: index * CHUNK_MS, step_ms: STEP_MS, min: low, max: high }
        RecordingEditor.atomic_write(cache, JSON.generate(result))
        result
      ensure
        @mutex.synchronize { @active.delete(identity) }
      end
    end

    def decode(audio, start_ms)
      args = [@repo.ffmpeg, '-nostdin', '-v', 'error', '-threads', '1', '-ss', (start_ms / 1000.0).to_s,
              '-i', audio, '-t', (CHUNK_MS / 1000.0).to_s, '-vn', '-ac', '1',
              '-af', "aresample=#{RATE},atrim=end_sample=#{CHUNK_MS * RATE / 1000},asetpts=N/SR/TB", '-ar', RATE.to_s,
              '-threads', '1', '-f', 'f32le', '-']
      Open3.popen3(*args) do |input, output, errors, worker|
        input.close
        error_reader = Thread.new { errors.read }
        begin
          Timeout.timeout(8) do
            # Also bound memory if a misconfigured executable ignores -t.
            pcm = output.read(CHUNK_MS * RATE / 1000 * 4 + 1) || ''.b
            raise Error.new('詳細波形の出力が大きすぎます。', 422) if pcm.bytesize > CHUNK_MS * RATE / 1000 * 4
            raise Error.new('詳細波形を生成できませんでした。', 422) unless worker.value.success?
            pcm
          end
        ensure
          begin
            Process.kill('KILL', worker.pid) if worker.alive?
          rescue Errno::ESRCH
            # The wait thread may still be alive just after FFmpeg exits.
          end
          error_reader.join
        end
      end
    rescue Timeout::Error
      raise Error.new('詳細波形の生成がタイムアウトしました。再試行してください。', 503)
    rescue Errno::ENOENT
      raise Error.new('ffmpegが見つかりません。', 503)
    end
  end
end
