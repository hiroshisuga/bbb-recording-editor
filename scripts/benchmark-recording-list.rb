#!/usr/bin/env ruby
# frozen_string_literal: true
# Synthetic list API work only. Creates temporary recordings, never uses BBB data.
require 'optparse'
require 'tmpdir'
require 'benchmark'
require 'objspace'
require_relative '../editor/lib/recording_editor'

options = { meetings: 300, events: 1000, iterations: 5 }
OptionParser.new do |parser|
  parser.banner = 'Usage: ruby scripts/benchmark-recording-list.rb --output FILE [--meetings 300 --events 1000 --iterations 5]'
  parser.on('--output FILE') { |value| options[:output] = value }
  %i[meetings events iterations].each { |key| parser.on("--#{key} N", Integer) { |value| options[key] = value } }
end.parse!
abort 'An output path and positive counts are required (at least two events).' unless options[:output] && options.values_at(:meetings, :events, :iterations).all?(&:positive?) && options[:events] >= 2

# Count actual parses rather than inferring cache hits from elapsed time.
module CountListParses
  attr_accessor :list_benchmark_parses
  def xml(data)
    self.list_benchmark_parses = (list_benchmark_parses || 0) + 1
    super
  end
end
RecordingEditor.singleton_class.prepend(CountListParses)

def measure(repo, iterations, cache:)
  times, parses = [], []
  iterations.times do
    RecordingEditor.list_benchmark_parses = 0
    times << Benchmark.realtime { repo.list(cache: cache) } * 1000
    parses << RecordingEditor.list_benchmark_parses
  end
  { samples_ms: times, median_ms: times.sort[times.length / 2], xml_parses: parses }
end

# Retained entry graph estimate, not total RSS or allocator overhead.
def retained_bytes(value, seen = {})
  return 0 if seen[value.object_id]
  seen[value.object_id] = true
  children = case value
             when Hash then value.flat_map { |key, item| [key, item] }
             when Array then value
             when Rational then [value.numerator, value.denominator]
             else []
             end
  ObjectSpace.memsize_of(value) + children.sum { |child| retained_bytes(child, seen) }
end

Dir.mktmpdir('bbb-list-benchmark-') do |dir|
  config = { raw_root: "#{dir}/raw", state_root: "#{dir}/state", published_root: "#{dir}/published", unpublished_root: "#{dir}/unpublished" }
  body = Array.new(options[:events]) do |i|
    "<event timestamp='#{1000 + i * 1000}' eventname='ParticipantTalkingEvent'><userId>speaker-#{i % 10}</userId><talking>true</talking></event>"
  end.join
  xml = "<recording><metadata meetingName='Synthetic meeting'/><event timestamp='1000' eventname='RecordStatusEvent'><status>true</status></event>#{body}</recording>"
  ids = Array.new(options[:meetings]) { |i| "#{format('%040x', i + 1)}-1700000000000" }
  ids.each do |id|
    raw = File.join(config[:raw_root], id)
    meta = File.join(config[:unpublished_root], id)
    FileUtils.mkdir_p([raw, meta])
    File.write(File.join(raw, 'events.xml'), xml)
    File.write(File.join(meta, 'metadata.xml'), '<recording><state>unpublished</state><published>false</published><meta><name>Synthetic title</name></meta></recording>')
  end
  repo = RecordingEditor::Repository.new(**config)
  uncached = measure(repo, options[:iterations], cache: false)
  cold = measure(repo, 1, cache: true)
  warm = measure(repo, options[:iterations], cache: true)
  raise 'Warm list parsed unchanged XML' unless warm[:xml_parses].all?(&:zero?)
  before = repo.list
  File.write(File.join(config[:raw_root], ids.first, 'events.xml'), xml.sub('Synthetic meeting', 'Changed meeting'))
  changed = measure(repo, 1, cache: true)
  raise 'Changed meeting was not reparsed exactly once' unless changed[:xml_parses] == [1]
  after = repo.list
  raise 'Changed summary not reflected' unless after.find { |row| row[:id] == ids.first }[:meeting_name] == 'Changed meeting'
  raise 'Unrelated summaries changed' unless before.reject { |row| row[:id] == ids.first } == after.reject { |row| row[:id] == ids.first }
  entries = repo.instance_variable_get(:@list_cache).instance_variable_get(:@entries)
  output = { at: Time.now.utc.iso8601, ruby: RUBY_DESCRIPTION, platform: RUBY_PLATFORM,
    scope: 'Synthetic local list assembly, XML parsing and filesystem checks; bypass vs cold/warm process-local cache. Excludes HTTP, browser, media processing and production BBB data.',
    meetings: options[:meetings], events_per_meeting: options[:events] + 1, raw_xml_bytes: xml.bytesize * ids.size,
    uncached: uncached, cold: cold, warm: warm, one_raw_changed: changed,
    retained_entries: entries.size, retained_entry_graph_bytes: retained_bytes(entries) }
  FileUtils.mkdir_p(File.dirname(File.expand_path(options[:output])))
  File.write(options[:output], JSON.pretty_generate(output) + "\n")
  puts JSON.pretty_generate(output)
end
