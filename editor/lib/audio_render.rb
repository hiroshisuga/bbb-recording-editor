# frozen_string_literal: true

module RecordingEditor
  # Reuse only the latest successful save, on the unchanged original clock.
  # Keep ranges are intentionally absent: they affect BBB's cuts, not samples.
  class AudioRender
    def initialize(rec)
      @rec = rec
    end

    def fingerprint(beeps, cues, legacy: false)
      sources = @rec.assets.map do |asset|
        next asset unless asset['relative'] && %w[audio deskshare].include?(asset['kind'])
        paths = [@rec.repo.raw_file(@rec.id, asset['relative']),
                 File.join(@rec.repo.state_dir(@rec.id), 'original-media', asset['relative'])]
        stats = paths.map do |path|
          stat = File.stat(path) if File.file?(path)
          stat && [stat.size, stat.mtime.to_r.to_s, stat.ctime.to_r.to_s]
        end
        # Exclude URL/display fields. Include every field used by redaction.
        [asset.values_at('id', 'relative', 'kind', 'start_ms', 'end_ms', 'file_duration_ms',
                         'audio_codec', 'audio_count', 'has_audio', 'sample_rate', 'error'), stats]
      end
      parts = [legacy ? 'audio-render-v1' : 'audio-render-v2-media', Media::CLOCK_RESAMPLE,
               @rec.duration, sources, @rec.unmapped_audio, beeps, cues]
      parts << Digest::SHA256.file(CutChime::SAMPLE).hexdigest if legacy
      Digest::SHA256.hexdigest(JSON.generate(parts))
    end

    def cached(history, key, media_only: false)
      cache = history && history['audio_render']
      return unless cache.is_a?(Hash) && cache[media_only ? 'media_key' : 'key'] == key
      files, outputs, replacements = cache['files'], history['outputs'], cache['replacements']
      return unless files.is_a?(Array) && outputs.is_a?(Array) && replacements.is_a?(Array)
      if media_only
        outputs = outputs.reject { |o| o['cue'] }
        wanted = outputs.to_h { |o| [o['relative'], true] }
        files = files.select { |f| wanted[f['relative']] }
      end
      return unless files.map { |f| f['relative'] } == outputs.map { |o| o['relative'] }
      files.each do |file|
        relative = file.fetch('relative')
        return unless File.basename(relative).start_with?('bbb-editor-')
        path = @rec.repo.raw_file(@rec.id, relative)
        return unless File.size(path) == file['size'] && Digest::SHA256.file(path).hexdigest == file['sha256']
      end
      mapping = replacements.to_h do |entry|
        k, v = entry.values_at('event', 'filename')
        raise KeyError unless k.is_a?(Array) && k.size == 4 && v.is_a?(String)
        [k, v]
      end
      media = outputs.map { |o| o.select { |k, _| %w[source backup relative cue audio_render].include?(k) }.transform_keys(&:to_sym) }
      [mapping, media, cache]
    rescue Error, SystemCallError, KeyError, TypeError, NoMethodError
      nil # Missing, changed or legacy output: regenerate from originals.
    end

    def render(beeps, cues, staging, history:, progress:, sound: 'a')
      media_key = fingerprint(beeps, cues)
      sample_key = cues.empty? ? nil : [sound, Digest::SHA256.file(CutChime.sample(sound)).hexdigest]
      key = Digest::SHA256.hexdigest(JSON.generate([media_key, sample_key]))
      if (result = cached(history, key))
        progress.call('音声編集に変更がないため、保存済みの加工音声とチャイムを再利用しました。')
        return result
      end
      media = cached(history, media_key, media_only: true)
      previous_cache = history && history['audio_render']
      if !media && previous_cache.is_a?(Hash) && !previous_cache.key?('media_key')
        media = cached(history, fingerprint(beeps, cues, legacy: true))
        media[1] = media[1].reject { |output| output[:cue] } if media
      end
      if media
        replacements, outputs = media
      else
        replacements, outputs = Media.new(@rec).redact(beeps, staging, progress: progress, mute_ranges: cues)
      end
      outputs.concat(CutChime.render(cues, staging, @rec.repo.ffmpeg, sound: sound))
      cache = { 'key' => key, 'media_key' => media_key,
                'replacements' => replacements.map { |event, filename| { 'event' => event, 'filename' => filename } },
                'files' => outputs.map do |output|
                  path = output[:staged] || @rec.repo.raw_file(@rec.id, output.fetch(:relative))
                  { 'relative' => output.fetch(:relative), 'size' => File.size(path), 'sha256' => Digest::SHA256.file(path).hexdigest }
                end }
      [replacements, outputs, cache]
    end
  end
end
