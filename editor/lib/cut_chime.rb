# frozen_string_literal: true

module RecordingEditor
  module CutChime
    DURATION_MS = 250
    MIN_DURATION_MS = 20 # BBB's minimum Opus cut length.
    SAMPLE = File.expand_path('../assets/cut-cue-a.wav', __dir__)

    def self.enabled(payload)
      value = payload.fetch('cut_chime', false)
      raise Error, '合図音の設定が不正です。' unless value == true || value == false
      value
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
      extensions = cues.to_h { |cue| [cue['start_ms'], cue['end_ms']] }
      RecordingEditor.ranges(records.map { |r| r.merge('end_ms' => extensions.fetch(r['end_ms'], r['end_ms'])) }, duration)
    end

    def self.render(cues, staging, ffmpeg)
      cues.map do |cue|
        name = "bbb-editor-cue-#{SecureRandom.hex(6)}.wav"
        output = File.join(staging, name)
        seconds = (cue['end_ms'] - cue['start_ms']) / 1000.0
        if seconds == 0.25
          FileUtils.copy_file(SAMPLE, output)
        else
          RecordingEditor.run(ffmpeg, '-nostdin', '-v', 'error', '-y', '-i', SAMPLE,
                              '-t', seconds.to_s, '-af', "afade=t=out:st=#{[seconds - 0.005, 0].max}:d=0.005",
                              '-c:a', 'pcm_s16le', output)
        end
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
