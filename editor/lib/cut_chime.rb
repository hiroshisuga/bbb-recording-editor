# frozen_string_literal: true

module RecordingEditor
  module CutChime
    DURATION_MS = 250
    MIN_DURATION_MS = 20 # BBB's minimum Opus cut length.
    SAMPLE = File.expand_path('../assets/cut-cue-a.wav', __dir__)
    SOUNDS = { 'a' => SAMPLE, 'c' => File.expand_path('../assets/cut-cue-c.wav', __dir__),
               'tape' => File.expand_path('../assets/cut-cue-tape.wav', __dir__) }.freeze

    def self.sound(payload)
      value = payload.fetch('cut_chime_sound', 'a')
      raise Error, 'チャイムの音色が不正です。' unless SOUNDS.key?(value)
      value
    end

    def self.sample(sound = 'a')
      SOUNDS.fetch(self.sound('cut_chime_sound' => sound))
    end

    def self.enabled(payload)
      value = payload.fetch('cut_chime', false)
      raise Error, '合図音の設定が不正です。' unless value == true || value == false
      value
    end

    def self.gaps(records)
      records.each_cons(2).filter_map do |left, right|
        next if right['start_ms'] - left['end_ms'] < MIN_DURATION_MS
        { 'start_ms' => left['end_ms'], 'end_ms' => right['start_ms'] }
      end
    end

    # Explicit selections are authoritative, including an empty selection.
    # Legacy recordings/drafts keep exactly the cuts selected by the old flag;
    # upgrading must not silently enable chimes on original recording-OFF gaps.
    def self.selection(payload, records, original, duration)
      legacy_enabled = enabled(payload)
      candidates = gaps(records)
      unless payload.key?('cut_chime_gaps')
        legacy = legacy_enabled ? ranges(records, original, duration) : []
        return candidates.select { |gap| legacy.any? { |cue| cue['start_ms'] == gap['start_ms'] } }
      end
      selected = RecordingEditor.ranges(payload['cut_chime_gaps'], duration)
      unless selected.size == payload['cut_chime_gaps'].size && selected.all? { |gap| candidates.include?(gap) }
        raise Error, '繋ぎ目の選択が録画範囲と一致しません。選択を確認してください。'
      end
      selected
    end

    def self.cues(selected)
      selected.flat_map do |gap|
        length = gap['end_ms'] - gap['start_ms']
        if length <= DURATION_MS
          # Include a short gap in full: don't create sub-20ms audio tracks.
          [length < DURATION_MS ? gap.merge('fade_out' => true) : gap.dup]
        else
          half = DURATION_MS / 2
          [{ 'start_ms' => gap['start_ms'], 'end_ms' => gap['start_ms'] + half },
           { 'start_ms' => gap['end_ms'] - half, 'end_ms' => gap['end_ms'], 'sample_offset_ms' => half }]
        end
      end
    end

    # Only interior gaps which remove previously recorded content. If the
    # meeting was never marked, the editor's new ranges define its cuts.
    def self.ranges(records, original, duration)
      original = [{ 'start_ms' => 0, 'end_ms' => duration }] if original.empty?
      records.each_cons(2).filter_map do |left, right|
        from, to = left['end_ms'], right['start_ms']
        next if to - from < MIN_DURATION_MS
        next unless original.any? { |r| r['start_ms'] < to && r['end_ms'] > from }
        { 'start_ms' => from, 'end_ms' => [from + DURATION_MS, to].min }
      end
    end

    def self.effective(records, cues, duration)
      ends = cues.to_h { |cue| [cue['start_ms'], cue['end_ms']] }
      starts = cues.to_h { |cue| [cue['end_ms'], cue['start_ms']] }
      RecordingEditor.ranges(records.map do |r|
        r.merge('start_ms' => starts.fetch(r['start_ms'], r['start_ms']),
                'end_ms' => ends.fetch(r['end_ms'], r['end_ms']))
      end, duration)
    end

    def self.render(cues, staging, ffmpeg, sound: 'a')
      sample = self.sample(sound)
      templates = {}
      cues.map do |cue|
        name = "bbb-editor-cue-#{SecureRandom.hex(6)}.wav"
        output = File.join(staging, name)
        seconds = (cue['end_ms'] - cue['start_ms']) / 1000.0
        offset = cue.fetch('sample_offset_ms', 0) / 1000.0
        key = [seconds, offset, cue['fade_out']]
        if templates[key]
          FileUtils.copy_file(templates[key], output)
        elsif seconds == 0.25 && offset.zero?
          FileUtils.copy_file(sample, output)
        else
          # Split the selected sound without a fade/restart at the join. After BBB removes
          # the middle gap, these PCM slices form the original continuous cue.
          filter = "atrim=start=#{offset}:end=#{offset + seconds},asetpts=PTS-STARTPTS"
          filter += ",afade=t=out:st=#{[seconds - 0.005, 0].max}:d=0.005" if cue['fade_out']
          RecordingEditor.run(ffmpeg, '-nostdin', '-v', 'error', '-y', '-i', sample,
                              '-af', filter, '-c:a', 'pcm_s16le', output)
        end
        templates[key] = output
        { relative: "audio/#{name}", staged: output, cue: cue }
      end
    end

    def self.add_events(doc, outputs, origin)
      return if outputs.empty?
      # Use BBB's active-track mixing for both legacy VOICE and SFU sources.
      # Mixing a new AudioTrack into a legacy StartRecordingEvent directly
      # would otherwise drop the ongoing legacy source after the cue ends.
      doc.xpath('/recording/event[@module="VOICE" or @module="bbb-webrtc-sfu"]').each do |event|
        event['eventname'] = { 'StartRecordingEvent' => 'AudioTrackPublishedEvent',
                               'StopRecordingEvent' => 'AudioTrackUnpublishedEvent' }.fetch(event['eventname'], event['eventname'])
      end
      outputs.each do |output|
        [['start_ms', 'AudioTrackPublishedEvent'], ['end_ms', 'AudioTrackUnpublishedEvent']].each do |edge, type|
          node = Nokogiri::XML::Node.new('event', doc)
          node['timestamp'] = (origin + output[:cue][edge]).to_s
          node['module'], node['eventname'] = 'bbb-webrtc-sfu', type
          child = Nokogiri::XML::Node.new('filename', doc)
          child.content = File.basename(output[:relative])
          node.add_child(child)
          before = doc.xpath('/recording/event').find { |e| e['timestamp'].to_i > node['timestamp'].to_i }
          before ? before.add_previous_sibling(node) : doc.root.add_child(node)
        end
      end
    end
  end
end
