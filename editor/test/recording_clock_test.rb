# frozen_string_literal: true
require 'minitest/autorun'
require_relative '../lib/recording_editor'

class RecordingClockTest < Minitest::Test
  def test_client_effective_clock_fixtures_match_raw_save_intervals
    fixtures = JSON.parse(File.read(File.expand_path('../../src/components/recording-editor/__fixtures__/recording-clock.json', __dir__)))
    fixtures.each do |fixture|
      cues = RecordingEditor::CutChime.cues(fixture['gaps'])
      effective = RecordingEditor::CutChime.effective(fixture['records'], cues, fixture['duration'])
      assert_equal fixture['effective'], effective, fixture['name']
      assert_equal fixture['total'], effective.sum { |r| r['end_ms'] - r['start_ms'] }, fixture['name']
    end
  end
end
