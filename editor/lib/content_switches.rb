# frozen_string_literal: true

module RecordingEditor
  # Foreground content is independent of the lifetime of a screenshare file.
  # Work on the original event clock; never infer a switch from black pixels.
  module ContentSwitches
    TYPES = %w[SetScreenshareAsContentEvent SetPresentationIsOpenEvent LayoutBroadcastedEvent
               SharePresentationEvent GotoSlideEvent StartExternalVideoRecordEvent StopExternalVideoRecordEvent].freeze
    XPATH = '/recording/event[' + TYPES.map { |type| "@eventname='#{type}'" }.join(' or ') + ']'
    module_function

    def boolean(value)
      return true if value.to_s.casecmp?('true')
      return false if value.to_s.casecmp?('false')
      nil
    end

    def version_supported?(rec)
      version = rec.doc.root['bbb_version'].to_s.match(/\A(\d+)\.(\d+)\.(\d+)/)
      return false unless version
      major, minor, patch = version.captures.map(&:to_i)
      major == 4 || (major == 3 && (minor.positive? || patch >= 14))
    end

    def editable?(rec)
      version_supported?(rec) && rec.events_in_order
    end

    def events(rec)
      rec.doc.xpath(XPATH).each_with_index.filter_map do |node, index|
        next if %w[SetScreenshareAsContentEvent LayoutBroadcastedEvent].include?(node['eventname']) && node['module'] != 'PARTICIPANT'
        { time: rec.time(node), index: index, type: node['eventname'], node: node }
      end.sort_by { |event| [event[:time], event[:index]] }
    end

    def screen_flag(rec, node)
      boolean(rec.field(node, 'screenshareAsContent'))
    end

    def timeline(rec)
      changes = events(rec)
      screens = rec.assets.select { |asset| asset['kind'] == 'deskshare' }
      slides = rec.slides.to_h { |slide| [[slide['presentation'] || slide[:presentation], slide['page'] || slide[:page]], true] }
      points = ([0, rec.duration] + changes.map { |e| e[:time] } + screens.flat_map { |a| [a['start_ms'], a['end_ms']] })
               .select { |time| time && time >= 0 && time <= rec.duration }.uniq.sort
      screen_as_content = true
      screen_known = false
      presentation_open = true
      presentation = nil
      page = 1
      last_pages = {}
      external = false
      cursor = 0
      result = []
      points.each_cons(2) do |from, to|
        while cursor < changes.length && changes[cursor][:time] <= from
          event = changes[cursor]
          node = event[:node]
          case event[:type]
          when 'SetScreenshareAsContentEvent'
            value = screen_flag(rec, node)
            unless value.nil?
              screen_as_content = value
              screen_known = true
            end
          when 'LayoutBroadcastedEvent', 'SetPresentationIsOpenEvent'
            value = boolean(rec.field(node, 'presentationIsOpen', 'isOpen'))
            presentation_open = value unless value.nil?
          when 'SharePresentationEvent'
            name = rec.field(node, 'presentationName')
            if boolean(rec.field(node, 'share')) == false
              presentation = nil if !name || name == presentation
            else
              presentation = name
              page = last_pages[name] || 1
            end
          when 'GotoSlideEvent'
            presentation = rec.field(node, 'presentationName') || presentation
            page = rec.field(node, 'slide', 'id').to_i + 1
            last_pages[presentation] = page
          when 'StartExternalVideoRecordEvent' then external = true
          when 'StopExternalVideoRecordEvent' then external = false
          end
          cursor += 1
        end
        active = screens.select { |asset| asset['start_ms'] <= from && asset['end_ms'] > from }
        screen_available = active.any? { |asset| asset['has_video'] && !asset['error'] }
        slides_available = !!slides[[presentation, page]]
        source = if !presentation_open then 'none'
                 elsif external then 'external'
                 elsif screen_as_content && !active.empty? then 'screen'
                 elsif presentation || !slides.empty? then 'slides'
                 else 'none'
                 end
        segment = { 'start_ms' => from, 'end_ms' => to, 'source' => source,
                    'inferred' => !screen_known && !external && presentation_open,
                    'available' => { 'screen' => screen_available, 'slides' => slides_available, 'external' => true, 'none' => false }[source],
                    'screen_available' => screen_available, 'slides_available' => slides_available,
                    'editable' => presentation_open && !external }
        previous = result.last
        if previous && previous.reject { |key, _| %w[start_ms end_ms].include?(key) } == segment.reject { |key, _| %w[start_ms end_ms].include?(key) }
          previous['end_ms'] = to
        else
          result << segment
        end
      end
      result
    end

    def normalize(value, rec)
      value = [] if value.nil?
      raise Error, '表示内容の区間は500件以下の配列で指定してください。' unless value.is_a?(Array) && value.size <= 500
      raise Error, 'このBBBバージョンでは表示内容の変更を保存できません。' if !value.empty? && !version_supported?(rec)
      raise Error, 'イベントの時刻順が前後しているため、表示内容の変更を保存できません。' if !value.empty? && !rec.events_in_order
      normalized = value.map do |entry|
        raise Error, '表示内容の区間の形式が不正です。' unless entry.is_a?(Hash) && %w[screen slides].include?(entry['source'])
        range = RecordingEditor.ranges([entry], rec.duration).first
        raise Error, '表示内容の区間の形式が不正です。' unless range
        range.merge('source' => entry['source'])
      end.sort_by { |entry| entry['start_ms'] }
      merged = []
      normalized.each do |entry|
        previous = merged.last
        raise Error, '表示内容の変更区間が重複しています。' if previous && previous['end_ms'] > entry['start_ms']
        if previous && previous['end_ms'] == entry['start_ms'] && previous['source'] == entry['source']
          previous['end_ms'] = entry['end_ms']
        else
          merged << entry
        end
      end
      return merged if merged.empty?
      segments = timeline(rec)
      merged.each do |entry|
        covered = segments.select { |s| s['start_ms'] < entry['end_ms'] && s['end_ms'] > entry['start_ms'] }
        unless !covered.empty? && covered.all? { |s| s['editable'] && s["#{entry['source']}_available"] }
          raise Error, '選択範囲には表示できない素材、外部動画、または閉じたプレゼン領域が含まれています。'
        end
      end
      merged
    end

    def original_flag(rec, offset, changes = events(rec))
      changes.select { |event| event[:type] == 'SetScreenshareAsContentEvent' && event[:time] <= offset }
        .map { |event| screen_flag(rec, event[:node]) }.reject(&:nil?).last != false
    end

    def apply(updated, overrides, rec)
      return if overrides.empty?
      # Keep user/layout/navigation metadata. Only the foreground boolean is
      # overridden; original navigation and media continue in the background.
      updated.xpath('/recording/event[@module="PARTICIPANT" and @eventname="SetScreenshareAsContentEvent"]').each do |event|
        override = overrides.find { |r| r['start_ms'] <= rec.time(event) && rec.time(event) < r['end_ms'] }
        next unless override
        child = event.at_xpath('screenshareAsContent')
        unless child
          child = Nokogiri::XML::Node.new('screenshareAsContent', updated)
          event.add_child(child)
        end
        child.content = (override['source'] == 'screen').to_s
      end
      changes = events(rec)
      boundaries = overrides.flat_map do |range|
        [[range['start_ms'], 1, range['source'] == 'screen'], [range['end_ms'], 0, original_flag(rec, range['end_ms'], changes)]]
      end.sort_by { |offset, order, _| [offset, order] }
      existing = updated.xpath('/recording/event').to_a
      cursor = 0
      boundaries.each do |offset, _, enabled|
        node = Nokogiri::XML::Node.new('event', updated)
        node['timestamp'] = (rec.origin + offset).to_s
        node['module'], node['eventname'] = 'PARTICIPANT', 'SetScreenshareAsContentEvent'
        real = Time.parse(rec.start_utc) + offset / 1000.0
        { 'timestampUTC' => (real.to_f * 1000).round.to_s, 'date' => real.iso8601(3),
          'screenshareAsContent' => enabled.to_s }.each do |key, value|
          child = Nokogiri::XML::Node.new(key, updated)
          child.content = value
          node.add_child(child)
        end
        cursor += 1 while cursor < existing.length && existing[cursor]['timestamp'].to_i <= rec.origin + offset
        before = existing[cursor]
        before ? before.add_previous_sibling(node) : updated.root.add_child(node)
      end
    end
  end
end
