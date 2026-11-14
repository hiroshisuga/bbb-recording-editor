# frozen_string_literal: true
require 'minitest/autorun'
require 'timeout'
require_relative '../lib/list_cache'

class ListCacheTest < Minitest::Test
  def test_versions_rebuild_only_on_change_and_return_independent_values
    cache = RecordingEditor::ListCache.new
    version, builds = 1, 0
    read = -> { builds += 1; { title: 'Original', warnings: ['warning'] } }
    first = cache.fetch([:raw, 'id'], -> { version }, &read)
    first[:title].replace('Changed')
    first[:warnings].first.replace('Changed')
    hit = cache.fetch([:raw, 'id'], -> { version }, &read)
    assert_equal({ title: 'Original', warnings: ['warning'] }, hit)
    hit[:warnings] << 'extra'
    assert_equal ['warning'], cache.fetch([:raw, 'id'], -> { version }, &read)[:warnings]
    assert_equal 1, builds
    version += 1
    cache.fetch([:raw, 'id'], -> { version }, &read)
    assert_equal 2, builds
  end

  def test_errors_and_inputs_changed_during_build_are_not_cached
    cache = RecordingEditor::ListCache.new
    key, version = [:raw, 'id'], 1
    cache.fetch(key, -> { version }) { 'old' }
    version = 2
    assert_raises(IOError) { cache.fetch(key, -> { version }) { raise IOError } }
    assert_equal 0, cache.size
    cache.fetch(key, -> { version }) { version = 3; 'racing read' }
    assert_equal 0, cache.size
    assert_equal 'new', cache.fetch(key, -> { version }) { 'new' }
    assert_raises(Errno::EACCES) { cache.fetch(key, -> { raise Errno::EACCES }) { flunk } }
    assert_equal 0, cache.size
  end

  def test_mutating_a_callers_key_does_not_change_retained_entries
    cache = RecordingEditor::ListCache.new
    id = String.new('id')
    cache.fetch([:raw, id], -> { 1 }) { 'summary' }
    id.replace('changed')
    assert_equal 'summary', cache.fetch([:raw, 'id'], -> { 1 }) { flunk 'Retained key was mutated' }
    cache.retain(['id'])
    assert_equal 1, cache.size
  end

  def test_concurrent_cold_requests_share_a_builder_without_blocking_other_keys
    cache = RecordingEditor::ListCache.new
    entered, release = Queue.new, Queue.new
    threads = []
    Timeout.timeout(5) do
      threads << Thread.new do
        cache.fetch([:raw, 'a'], -> { 1 }) { entered << true; release.pop; { title: 'a' } }
      end
      entered.pop
      7.times do
        threads << Thread.new { cache.fetch([:raw, 'a'], -> { 1 }) { flunk 'Duplicate builder' } }
      end
      assert_equal 'b', cache.fetch([:raw, 'b'], -> { 1 }) { 'b' }
      release << true
      results = threads.map(&:value)
      assert results.all? { |result| result == { title: 'a' } }
      assert_equal 8, results.map(&:object_id).uniq.size
    end
  ensure
    threads&.each { |thread| thread.kill if thread.alive? }
  end

  def test_pruning_and_explicit_invalidation_do_not_discard_other_meetings
    cache = RecordingEditor::ListCache.new
    [[:raw, 'a'], [:metadata, '/published', 'a'], [:raw, 'b'], [:raw, 'removed']].each do |key|
      cache.fetch(key, -> { 1 }) { key.last }
    end
    cache.retain(%w[a b])
    assert_equal 3, cache.size
    cache.invalidate('a')
    assert_equal 1, cache.size
    assert_equal 'b', cache.fetch([:raw, 'b'], -> { 1 }) { flunk 'Unchanged meeting was discarded' }
    assert_empty cache.instance_variable_get(:@locks)
  end
end
