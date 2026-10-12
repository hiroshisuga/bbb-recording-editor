# frozen_string_literal: true

require 'net/http'
require 'json'
require 'uri'

module RecordingEditor
  module ExternalVideoTitle
    # Never fetch raw URLs or follow redirects: only these fixed public metadata hosts.
    PROVIDERS = {
      'youtube.com' => 'https://www.youtube.com/oembed',
      'www.youtube.com' => 'https://www.youtube.com/oembed',
      'm.youtube.com' => 'https://www.youtube.com/oembed',
      'youtu.be' => 'https://www.youtube.com/oembed',
      'www.youtu.be' => 'https://www.youtube.com/oembed',
      'youtube-nocookie.com' => 'https://www.youtube.com/oembed',
      'www.youtube-nocookie.com' => 'https://www.youtube.com/oembed',
      'vimeo.com' => 'https://vimeo.com/api/oembed.json',
      'www.vimeo.com' => 'https://vimeo.com/api/oembed.json',
      'player.vimeo.com' => 'https://vimeo.com/api/oembed.json',
      'soundcloud.com' => 'https://soundcloud.com/oembed',
      'www.soundcloud.com' => 'https://soundcloud.com/oembed'
    }.freeze

    def self.endpoint(url)
      return nil unless url.is_a?(String) && url.bytesize <= 4096
      video = URI.parse(url)
      return nil unless %w[http https].include?(video.scheme) && !video.userinfo
      provider = PROVIDERS[video.host&.downcase]
      return nil unless provider && [80, 443].include?(video.port)
      uri = URI(provider)
      uri.query = URI.encode_www_form(url: url, format: 'json')
      uri
    rescue URI::InvalidURIError
      nil
    end

    def self.fetch(url)
      uri = endpoint(url)
      return nil unless uri
      body = +''
      # Ignore environment proxies and use TLS with certificate verification.
      Net::HTTP.start(uri.host, uri.port, nil, use_ssl: true, open_timeout: 3, read_timeout: 3) do |http|
        http.request(Net::HTTP::Get.new(uri.request_uri)) do |response|
          return nil unless response.is_a?(Net::HTTPSuccess)
          response.read_body do |chunk|
            body << chunk
            return nil if body.bytesize > 65_536
          end
        end
      end
      title = JSON.parse(body)['title']
      title.is_a?(String) && !title.strip.empty? ? title.strip[0, 512] : nil
    rescue StandardError
      # Private/deleted videos, network restrictions and malformed metadata are optional.
      nil
    end
  end
end
