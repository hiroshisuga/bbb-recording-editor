# frozen_string_literal: true

module RecordingEditor
  # Process-local, list-only summaries. Retain all live meetings: a small LRU
  # would evict its own entries on each full-list scan. Never retain XML/DOMs.
  class ListCache
    def initialize
      @entries, @locks, @mutex = {}, {}, Mutex.new
    end

    def fetch(key, signature)
      # List rows expose the same meeting ID strings used to address entries.
      # Own the key so a caller cannot mutate a retained Hash key via its row.
      key = key.map { |part| part.is_a?(String) ? part.dup.freeze : part }.freeze
      lock = @mutex.synchronize do
        entry = (@locks[key] ||= { mutex: Mutex.new, users: 0 })
        entry[:users] += 1
        entry
      end
      begin
        # Coalesce concurrent cold requests for this meeting/file, without
        # serializing XML parsing for unrelated meetings under the global lock.
        lock[:mutex].synchronize do
          version = signature.call
          entry = @mutex.synchronize { @entries[key] }
          return duplicate(entry[:value]) if entry && entry[:version] == version

          value = yield
          # Files may be replaced while we parse. Return the ordinary snapshot
          # to this caller, but never retain it under an obsolete signature.
          if signature.call == version
            snapshot = duplicate(value)
            @mutex.synchronize { @entries[key] = { version: version, value: snapshot } }
          else
            delete(key)
          end
          duplicate(value)
        rescue StandardError
          delete(key) # Failures and unreadable inputs are retried next time.
          raise
        end
      ensure
        @mutex.synchronize do
          lock[:users] -= 1
          @locks.delete(key) if lock[:users].zero?
        end
      end
    end

    def delete(key)
      @mutex.synchronize { @entries.delete(key) }
    end

    def invalidate(id)
      @mutex.synchronize { @entries.delete_if { |key, _entry| key.last == id } }
    end

    def retain(ids)
      @mutex.synchronize { @entries.delete_if { |key, _entry| !ids.include?(key.last) } }
    end

    def size
      @mutex.synchronize { @entries.size }
    end

    private

    # Callers assemble and decorate list rows. Mutable names/warnings must not
    # be shared across requests or threads, including the first cache miss.
    def duplicate(value)
      case value
      when Hash then value.to_h { |key, item| [key, duplicate(item)] }
      when Array then value.map { |item| duplicate(item) }
      when String then value.dup
      else value
      end
    end
  end
end
