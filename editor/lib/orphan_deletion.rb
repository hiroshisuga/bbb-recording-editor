# frozen_string_literal: true

require 'yaml'
require 'net/http'
require 'etc'

module RecordingEditor
  # Never implement BBB's deletion with FileUtils.rm_rf. Review the exact scope
  # of the installed, supported bbb-record, then delegate to it as the service user.
  class OrphanDeletion
    COMMAND = '/usr/bin/bbb-record'
    CONFIG = '/usr/local/bigbluebutton/core/scripts/bigbluebutton.yml'
    PROPERTIES = ['/usr/share/bbb-web/WEB-INF/classes/bigbluebutton.properties', '/etc/bigbluebutton/bbb-web.properties'].freeze
    WORKFLOWS = '/usr/local/bigbluebutton/core/scripts/process'
    DELETE_BLOCK_SHA = '9ce2c4488293bf7ed1669cb5713320a4587986921e9aa1d96ecf66ef525edc57'
    MAX_ENTRIES = 100_000

    def initialize(repo)
      @repo = repo
    end

    def configuration
      script = File.binread(COMMAND)
      setup = script.split('declare -r BBB_YML=', 2)[1]&.split('readonly TYPES', 2)&.first
      setup = setup.to_s.gsub('yq-go e', 'yq e')
      raise Error.new('bbb-recordの設定処理が確認済みの形式と異なります。削除できません。', 503) unless Digest::SHA256.hexdigest(setup) == '2e40cc459284760e9009eaaeab149b6e707630fb8015b95eb5b16e1d90fc574b'
      block = script.split("if [ $DELETE ]; then\n", 2)[1]&.split("\nif [ $DELETEALL ]; then", 2)&.first
      normalized = block.to_s.strip.lines.map(&:strip).reject { |line| line.empty? || line.start_with?('#') }.join("\n")
      raise Error.new('bbb-recordの削除処理が確認済みの形式と異なります。削除は行っていません。', 503) unless Digest::SHA256.hexdigest(normalized) == DELETE_BLOCK_SHA
      stat = File.stat(COMMAND)
      raise Error.new('bbb-recordはroot所有で、グループや他ユーザーから書き換えできない必要があります。', 503) unless stat.uid.zero? && stat.mode & 0o022 == 0
      text = File.binread(CONFIG)
      config = YAML.safe_load(text, permitted_classes: [], aliases: false)
      roots = %w[recording_dir log_dir published_dir raw_audio_src raw_presentation_src].to_h do |key|
        value = config.fetch(key)
        raise Error, 'BBBの録画保存先設定が不正です。' unless value.is_a?(String) && value.start_with?('/') && File.expand_path(value) == value && value != '/' && !value.match?(/[\[\]*?{}\\]/)
        [key, value]
      end
      scripts = Dir.children(WORKFLOWS).grep(/\.rb\z/)
      raise Error, '対応していないBBBワークフロー名があります。' unless scripts.all? { |name| name.match?(/\A[a-zA-Z0-9_-]+\.rb\z/) && File.file?(File.join(WORKFLOWS, name)) && !File.symlink?(File.join(WORKFLOWS, name)) }
      roots.each_value { |path| check_ancestors(path) }
      # Match bbb-record's `sed s/.rb//g`, including custom workflow names.
      workflows = scripts.map { |f| f.gsub(/.rb/, '') }.reject(&:empty?).sort
      raise Error, 'BBBの録画ワークフローが見つかりません。' if workflows.empty?
      r, p, pub = roots.values_at('recording_dir', 'raw_presentation_src', 'published_dir')
      expected = [File.join(r, 'raw'), File.join(pub, 'presentation'), File.join(p, 'unpublished/presentation'), File.join(r, 'process/presentation'), File.join(p, 'recording/status')]
      actual = [@repo.raw_root, @repo.published_root, @repo.unpublished_root, @repo.process_root, @repo.status_root]
      raise Error, 'BBBとエディターの録画保存先が一致しないため削除できません。' unless expected == actual
      [roots, workflows, Digest::SHA256.hexdigest(script + text + workflows.join('\n'))]
    rescue KeyError, Psych::Exception, Errno::ENOENT, Errno::EACCES
      raise Error.new('BBBの削除コマンドまたは設定を読み取れません。管理者がアクセス権を確認してください。', 503)
    end

    # Verify against BBB itself, rather than assuming that old IDs cannot be live.
    def ensure_not_live(id)
      properties = {}
      PROPERTIES.each do |path|
        next unless File.file?(path)
        File.foreach(path) do |line|
          match = line.match(/\A\s*(securitySalt|bigbluebutton\.web\.serverURL)\s*=\s*(.*?)\s*\z/)
          properties[match[1]] = match[2] if match
        end
      end
      salt, base = properties.values_at('securitySalt', 'bigbluebutton.web.serverURL')
      raise Error, '開催中の会議を確認できません。BBB API設定を読み取れるか管理者が確認してください。' if salt.to_s.empty? || base.to_s.empty?
      uri = URI("#{base.delete_suffix('/')}/bigbluebutton/api/getMeetings")
      raise Error, 'BBB APIのURL設定が不正です。' unless %w[http https].include?(uri.scheme) && uri.host && !uri.userinfo
      uri.query = URI.encode_www_form(checksum: Digest::SHA256.hexdigest('getMeetings' + salt))
      # Use the local administrator-configured endpoint, never an HTTP proxy.
      response = Net::HTTP.start(uri.host, uri.port, nil, use_ssl: uri.scheme == 'https', open_timeout: 5, read_timeout: 10) { |http| http.get(uri.request_uri) }
      raise Error.new('BBBの開催中の会議を確認できません。', 503) unless response.is_a?(Net::HTTPSuccess) && response.body.bytesize <= 5_000_000 && !response.body.match?(/<!DOCTYPE/i)
      doc = Nokogiri::XML(response.body) { |c| c.strict.nonet }
      raise Error.new('BBBが開催中の会議の確認を受け付けませんでした。', 503) unless doc.at_xpath('/response/returncode')&.text == 'SUCCESS'
      raise Error.new('この会議は開催中のため削除できません。', 409) if doc.xpath('//internalMeetingID').any? { |node| node.text == id }
    rescue Error
      raise
    rescue StandardError
      # Do not expose URLs, checksums, or API configuration through errors/logs.
      raise Error.new('開催中の会議をBBBに確認できません。削除は行っていません。', 503)
    end

    def plan(id)
      @repo.check_id(id)
      @repo.ensure_not_rebuilding(id)
      raise Error, '削除には正しい内部会議IDが必要です。' unless id.match?(/\A[0-9a-f]{40}-[0-9]{13}\z/)
      candidate = @repo.list.find { |item| item[:id] == id }
      raise Error.new('ここで削除できるのは「未生成」で、rawファイルが残っていない項目だけです。', 409) unless candidate && candidate.values_at(:generation_status, :publication_status, :recording_status, :raw_available, :raw_data_status) == ['not_generated', 'not_generated', 'unknown', false, 'missing']
      raise Error.new('events.xmlが存在するため削除できません。', 409) if File.exist?(File.join(@repo.raw_root, id, 'events.xml'))
      roots, workflows, configuration_hash = configuration
      ensure_not_live(id)
      r, p, pub, log, audio = roots.values_at('recording_dir', 'raw_presentation_src', 'published_dir', 'log_dir', 'raw_audio_src')
      patterns = %w[ended recorded archived sanity processed published].map { |step| File.join(p, 'recording/status', step, "#{id}*") }
      # Inspect every format, including those no longer installed/enabled.
      %W[#{pub} #{p}/unpublished #{p}/deleted #{r}/process #{r}/publish].each do |root|
        raise Error.new('関連する生成済み・処理中の録画があるため削除できません。', 409) unless matches(File.join(root, '*', "#{id}*")).empty?
      end
      workflows.each do |type|
        patterns << File.join(log, type, "*#{id}*")
      end
      patterns += [File.join(p, 'captions', "#{id}*"), File.join(p, 'inbox', "#{id}*.json"), File.join(p, 'inbox', "#{id}*.txt"),
                   File.join(r, 'raw', "#{id}*"), File.join(p, 'screenshare', "#{id}*.flv"), File.join(audio, "#{id}*.wav"), File.join(audio, "#{id}*.opus"), File.join(p, id)]
      paths = patterns.flat_map { |pattern| matches(pattern) }.uniq.sort
      raise Error.new('BBBの削除対象は残っていません。', 409) if paths.empty?
      # Prefix matching is part of bbb-record. Do not erase another raw variant
      # which has an XML that the presentation-only list did not inspect.
      raise Error.new('関連するrawディレクトリにXMLがあるため削除できません。', 409) if matches(File.join(r, 'raw', "#{id}*", 'events.xml')).any?
      entries = []
      visit = lambda do |path|
        check_ancestors(path)
        stat = File.lstat(path)
        raise Error, 'シンボリックリンクや特殊ファイルはこの画面から削除できません。' unless stat.file? || stat.directory?
        raise Error, '対象が多すぎます。サーバーの管理ツールで確認してください。' if entries.length >= MAX_ENTRIES
        entries << { path: path, type: stat.directory? ? 'directory' : 'file', bytes: stat.file? ? stat.size : 0,
                     identity: [stat.dev, stat.ino, stat.mode, stat.size, stat.mtime.to_r.to_s, stat.ctime.to_r.to_s] }
        Dir.children(path).sort.each { |child| visit.call(File.join(path, child)) } if stat.directory?
      end
      paths.each { |path| visit.call(path) unless entries.any? { |entry| entry[:path] == path } }
      revision = Digest::SHA256.hexdigest(JSON.generate([configuration_hash, entries]))
      { id: id, name: candidate[:name], date: candidate[:date], command: "#{COMMAND} --delete #{id}", revision: revision,
        entries: entries.map { |entry| entry.reject { |key, _| key == :identity } },
        file_count: entries.count { |entry| entry[:type] == 'file' }, bytes: entries.sum { |entry| entry[:bytes] },
        retained: File.join(@repo.state_root, id) }
    rescue SystemCallError
      raise Error.new('削除対象をすべて確認できません。削除は行っていません。', 503)
    end

    # Dir.glob can silently skip unreadable directories. A deletion review must
    # fail instead, otherwise the BBB command could delete unreviewed targets.
    def matches(pattern)
      paths = ['/']
      parts = pattern.split('/').reject(&:empty?)
      parts.each_with_index do |part, index|
        paths = paths.flat_map do |parent|
          names = part.match?(/[*?]/) ? Dir.children(parent).select { |name| File.fnmatch?(part, name, File::FNM_DOTMATCH) } : [part]
          names.filter_map do |name|
            path = File.join(parent, name)
            begin
              stat = File.lstat(path)
              raise Error, '削除対象のパスにシンボリックリンクがあるため削除できません。' if stat.symlink?
              raise Error, '削除対象のディレクトリ構成が不正です。' if index < parts.length - 1 && !stat.directory?
              path
            rescue Errno::ENOENT
              nil
            end
          end
        end
      end
      paths
    end

    def check_ancestors(path)
      loop do
        raise Error, '削除対象のパスにシンボリックリンクがあるため削除できません。' if File.symlink?(path)
        parent = File.dirname(path)
        break if parent == path
        path = parent
      end
    end

    def delete(id, payload)
      raise Error, '削除対象を確認して会議ID全体を入力してください。' unless payload['confirmed'] == true && payload['meeting_id'] == id
      current = plan(id)
      raise Error.new('削除対象が変更されました。閉じてファイル一覧を確認し直してください。', 409) unless current[:revision] == payload['revision']
      _out, err, status = Open3.capture3({ 'PATH' => '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'LANG' => 'C.UTF-8', 'USER' => Etc.getpwuid(Process.euid).name, 'LOGNAME' => Etc.getpwuid(Process.euid).name }, COMMAND, '--delete', id, chdir: '/', unsetenv_others: true)
      # The BBB shell script can exit successfully even when an earlier rm failed.
      remaining = current[:entries].select { |entry| File.exist?(entry[:path]) || File.symlink?(entry[:path]) }.map { |entry| entry[:path] }
      unless status.success? && remaining.empty?
        warn "BBB orphan deletion failed for #{id}: #{err.lines.last(8).join}"
        raise Error.new('BBBによる削除に失敗したかファイルが残っています。一覧を更新して確認してください。強制削除は行っていません。', 422)
      end
      { id: id, deleted: true, retained: current[:retained] }
    rescue Errno::ENOENT
      raise Error.new('bbb-recordが見つかりません。削除は行っていません。', 503)
    end
  end
end
