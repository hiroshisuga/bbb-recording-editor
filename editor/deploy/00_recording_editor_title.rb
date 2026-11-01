#!/usr/bin/ruby
# frozen_string_literal: true

# Installed independently of the app checkout. BBB runs this after processing,
# before publishing/callbacks. No API credentials or elevated commands needed.
require 'json'
require 'digest'
require 'fileutils'
require 'nokogiri'
require 'optparse'
require 'securerandom'
require 'time'

module RecordingEditorTitle
  RAW_ROOT = '/var/bigbluebutton/recording/raw'
  STATE_ROOT = '/var/lib/bbb-recording-editor'
  PROCESS_ROOT = '/var/bigbluebutton/recording/process/presentation'

  class Restore
    def initialize(raw_root: RAW_ROOT, state_root: STATE_ROOT, process_root: PROCESS_ROOT)
      @raw_root, @state_root, @process_root = [raw_root, state_root, process_root].map { |p| File.expand_path(p) }
    end

    def child(root, id)
      path = File.join(root, id)
      raise 'Invalid recording directory' if File.symlink?(path) || File.realpath(path) != File.join(File.realpath(root), id)
      path
    end

    def read_file(path)
      raise 'Invalid recording file' if File.symlink?(path) || !File.file?(path)
      File.binread(path)
    end

    def atomic_write(path, data)
      raise 'Invalid destination file' if File.symlink?(path)
      temp = File.join(File.dirname(path), ".editor-title-#{SecureRandom.hex(8)}")
      begin
        File.open(temp, File::WRONLY | File::CREAT | File::EXCL, 0o600) { |f| f.write(data); f.flush; f.fsync }
        if File.file?(path)
          stat = File.stat(path)
          File.chmod(stat.mode & 0o777, temp)
          File.chown(stat.uid, stat.gid, temp) if Process.uid.zero?
        end
        File.rename(temp, path)
      ensure
        File.unlink(temp) if File.exist?(temp)
      end
    end

    def call(id, format)
      raise 'Invalid meeting ID' unless id&.match?(/\A[0-9a-f]{40}-[0-9]{13}\z/)
      raise 'Invalid recording format' unless format&.match?(/\A[a-z0-9][a-z0-9_-]{0,63}\z/)
      # Ordinary BBB jobs, including recordings never edited here, are untouched.
      request_path = File.join(@state_root, id, 'rebuild-request.json')
      return :not_requested unless File.exist?(request_path) || File.symlink?(request_path)
      state = child(@state_root, id)
      request = JSON.parse(read_file(request_path))
      return :not_requested unless %w[requesting requested completed].include?(request['status'])
      title = request['recording_title']
      return :not_needed if title.nil?
      raise 'Invalid recording title snapshot' unless title.is_a?(String) && !title.strip.empty? &&
        request['request_id'].is_a?(String) && request['request_id'].match?(/\A[0-9a-f]{32}\z/) &&
        request['revision'].is_a?(String) && request['revision'].match?(/\A[0-9a-f]{64}\z/)
      status_path = File.join(state, "title-restore-#{format}.json")
      status = File.exist?(status_path) || File.symlink?(status_path) ? JSON.parse(read_file(status_path)) : {}
      return :already_restored if status['request_id'] == request['request_id'] && status['status'] == 'published'
      begin
        raw = child(@raw_root, id)
        raise 'Raw XML changed after rebuild request' unless Digest::SHA256.hexdigest(read_file(File.join(raw, 'events.xml'))) == request['revision']
        root = format == 'presentation' ? @process_root : File.join(File.dirname(@process_root), format)
        metadata_path = File.join(child(root, id), 'metadata.xml')
        # Filesystem mtime may have coarser precision than the request clock.
        raise 'Processed metadata predates rebuild request' if File.mtime(metadata_path).to_i < Time.iso8601(request.fetch('requested_at')).to_i
        original = read_file(metadata_path)
        doc = Nokogiri::XML(original) { |config| config.strict.nonet }
        raise 'Invalid recording metadata' unless doc.root&.name == 'recording' && !doc.internal_subset
        return :already_restored if status['request_id'] == request['request_id'] && status['status'] == 'restored' && doc.at_xpath('/recording/meta/name')&.text == title
        meta = doc.at_xpath('/recording/meta')
        unless meta
          meta = Nokogiri::XML::Node.new('meta', doc)
          doc.root.add_child(meta)
        end
        meta.xpath('name').each(&:remove)
        name = Nokogiri::XML::Node.new('name', doc)
        name.content = title
        meta.add_child(name)
        atomic_write(metadata_path, doc.to_xml)
        atomic_write(status_path, JSON.generate('request_id' => request['request_id'], 'status' => 'restored', 'restored_at' => Time.now.utc.iso8601(6)))
        :restored
      rescue StandardError
        atomic_write(status_path, JSON.generate('request_id' => request['request_id'], 'status' => 'failed'))
        raise
      end
    end

    # This receipt is finalized after publishing independently of browser polling.
    # Failed process/publish attempts may retry; later unrelated rebuilds must not
    # replay a previously consumed title, even if the editor has been closed.
    def published(id, format)
      raise 'Invalid meeting ID' unless id&.match?(/\A[0-9a-f]{40}-[0-9]{13}\z/)
      raise 'Invalid recording format' unless format&.match?(/\A[a-z0-9][a-z0-9_-]{0,63}\z/)
      request_path = File.join(@state_root, id, 'rebuild-request.json')
      return :not_requested unless File.exist?(request_path)
      state = child(@state_root, id)
      request = JSON.parse(read_file(request_path))
      status_path = File.join(state, "title-restore-#{format}.json")
      return :not_restored unless File.exist?(status_path)
      status = JSON.parse(read_file(status_path))
      return :not_restored unless status['request_id'] == request['request_id'] && status['status'] == 'restored'
      atomic_write(status_path, JSON.generate(status.merge('status' => 'published', 'published_at' => Time.now.utc.iso8601(6))))
      :published
    end
  end
end

if $PROGRAM_NAME == __FILE__
  begin
    options = {}
    parser = OptionParser.new do |p|
      p.on('-m ID') { |value| options[:id] = value }
      p.on('-f FORMAT') { |value| options[:format] = value }
    end
    parser.parse!(ARGV)
    raise 'Unexpected arguments' unless ARGV.empty?
    restore = RecordingEditorTitle::Restore.new
    if File.basename(File.dirname(__FILE__)) == 'post_publish'
      restore.published(options[:id], options[:format])
    else
      restore.call(options[:id], options[:format])
    end
  rescue StandardError => error
    warn "Recording editor title restore failed: #{error.message}"
    exit 1
  end
end
