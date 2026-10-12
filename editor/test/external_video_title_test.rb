# frozen_string_literal: true

require 'minitest/autorun'
require 'minitest/mock'
require_relative '../lib/external_video_title'

class ExternalVideoTitleTest < Minitest::Test
  def metadata(body, response_class = Net::HTTPOK)
    response = response_class.new('1.1', '200', 'OK')
    response.define_singleton_method(:read_body) { |&block| block.call(body) }
    http = Object.new
    http.define_singleton_method(:request) { |_request, &block| block.call(response) }
    transport = lambda do |host, port, proxy, **options, &block|
      assert_equal 'www.youtube.com', host
      assert_equal 443, port
      assert_nil proxy
      assert_equal true, options[:use_ssl]
      assert_equal 3, options[:open_timeout]
      assert_equal 3, options[:read_timeout]
      block.call(http)
    end
    Net::HTTP.stub(:start, transport) { RecordingEditor::ExternalVideoTitle.fetch('https://youtu.be/video') }
  end

  def test_fixed_metadata_hosts_preserve_the_video_url
    {
      'https://www.youtube.com/watch?v=abc&t=45' => ['www.youtube.com', '/oembed'],
      'https://youtu.be/abc' => ['www.youtube.com', '/oembed'],
      'https://www.youtube-nocookie.com/embed/abc' => ['www.youtube.com', '/oembed'],
      'https://vimeo.com/123/private-hash' => ['vimeo.com', '/api/oembed.json'],
      'https://soundcloud.com/artist/track' => ['soundcloud.com', '/oembed']
    }.each do |url, expected|
      uri = RecordingEditor::ExternalVideoTitle.endpoint(url)
      assert_equal expected, [uri.host, uri.path]
      assert_equal url, URI.decode_www_form(uri.query).to_h['url']
    end
  end

  def test_untrusted_or_unsupported_hosts_are_not_fetched
    Net::HTTP.stub(:start, ->(*) { flunk 'Unexpected outbound request' }) do
      [nil, 123, 'javascript:alert(1)', 'https://127.0.0.1/video', 'https://youtube.com.attacker.invalid/video',
       'https://youtube.com@attacker.invalid/video', 'https://user:pass@youtube.com/video',
       'https://youtube.com:8099/video', 'https://example.com/video.mp4', 'x' * 5000].each do |url|
        assert_nil RecordingEditor::ExternalVideoTitle.fetch(url)
      end
    end
  end

  def test_titles_are_plain_strings_trimmed_and_bounded
    assert_equal 'A <title> & B', metadata(JSON.generate(title: ' A <title> & B '))
    assert_equal 512, metadata(JSON.generate(title: 'a' * 1000)).length
  end

  def test_bad_missing_or_oversized_responses_return_no_title
    ['not json', 'null', '{}', '{"title":123}', '{"title":"  "}', 'a' * 65_537].each do |body|
      assert_nil metadata(body)
    end
  end

  def test_redirects_are_not_followed_and_network_failure_is_optional
    assert_nil metadata('', Net::HTTPFound)
    Net::HTTP.stub(:start, ->(*) { raise Net::OpenTimeout }) do
      assert_nil RecordingEditor::ExternalVideoTitle.fetch('https://youtu.be/video')
    end
  end
end
