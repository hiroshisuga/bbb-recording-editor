"""Real codec/container checks for the optional Opus accelerator."""
import array
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('partial_opus', Path(__file__).parents[1] / 'lib/partial_opus.py')
partial = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(partial)
HAS_AV = importlib.util.find_spec('av') is not None


def ff(*args):
    return subprocess.check_output(['ffmpeg', '-v', 'error', '-nostdin', '-y', *map(str, args)], stderr=subprocess.PIPE)


class PlanningTest(unittest.TestCase):
    def test_edges_large_edits_and_nonfinite_ranges_fall_back(self):
        for masks in [[{'start_ms': 0, 'end_ms': 20}], [{'start_ms': 100, 'end_ms': 5900}],
                      [{'start_ms': float('nan'), 'end_ms': 1000}], [{'start_ms': 5, 'end_ms': float('inf')}]]:
            with self.assertRaises(partial.Unsupported):
                partial.plan(masks, 960, 312, 301)

    def test_neighboring_edits_share_context_and_long_windows_are_split(self):
        windows = partial.plan([{'start_ms': 3000, 'end_ms': 3100}, {'start_ms': 3150, 'end_ms': 3250}], 960, 312, 3001)
        self.assertEqual(1, len(windows))
        for frame in (480, 960, 2880):
            windows = partial.plan([{'start_ms': 3000, 'end_ms': 103547}], frame, 312, 600 * 48000 // frame)
            self.assertGreater(len(windows), 1)
            for a, b in zip(windows, windows[1:]):
                self.assertEqual(a[1], b[0])
                self.assertLess(b[5], a[6])
            for window in windows:
                self.assertLessEqual(window[4] - window[3], partial.MAX_CHUNK_SAMPLES)
                self.assertLessEqual((window[6] - window[5]) * frame, partial.MAX_CHUNK_SAMPLES)
        # Splitting one logical edit must not consume the 32 disjoint-group cap.
        self.assertGreater(len(partial.plan([{'start_ms': 3000, 'end_ms': 1003000}], 960, 312, 300001)), 32)


@unittest.skipUnless(HAS_AV, 'optional python3-av not installed')
class CodecTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='opus-test-')
        self.root = Path(self.directory.name)
        self.source = self.root / 'source.webm'
        self.output = self.root / 'out.webm'
        self.generate()

    def tearDown(self):
        self.directory.cleanup()

    def generate(self, codec='libopus', frame=20, channels=2, extra=(), duration=12):
        ff('-f', 'lavfi', '-i', f'aevalsrc=0.12*sin(2*PI*(220*t+3*t*t))|0.12*sin(2*PI*(370*t+5*t*t)):s=48000:d={duration}',
           '-ac', channels, '-c:a', codec, *(['-frame_duration', frame] if codec == 'libopus' else []), *extra, self.source)

    def headerless_source(self, channels=2, gap=False, keep_delay=False, duration=12):
        import av
        self.generate(channels=channels, duration=duration)
        path = self.root / 'headerless.webm'
        with av.open(str(self.source)) as src, av.open(str(path), 'w', format='webm') as dst:
            stream = src.streams.audio[0]
            out = dst.add_stream_from_template(stream) if hasattr(dst, 'add_stream_from_template') else dst.add_stream(template=stream)
            head = bytearray(stream.codec_context.extradata)
            if not keep_delay:
                head[10:12] = b'\0\0'
            out.codec_context.extradata = bytes(head)
            for i, packet in enumerate(p for p in src.demux(stream) if p.size):
                if not keep_delay:
                    packet.pts = packet.dts = i * 20 + (100 if gap and i >= 300 else 0)
                packet.stream = out
                dst.mux(packet)
        # Replace CodecPrivate with an equal-sized EBML Void, preserving all
        # cluster offsets. This models a real file with no OpusHead at all.
        data = path.read_bytes()
        element = b'\x63\xa2\x93' + bytes(head)
        self.assertEqual(1, data.count(element))
        data = bytearray(data.replace(element, b'\xec\x94' + bytes(20)))
        path.write_bytes(data)
        with av.open(str(path)) as check:
            first = next(p for p in check.demux(check.streams.audio[0]) if p.size)
            negative_start = first.pts < 0
        if not keep_delay and negative_start:
            # Older muxers retain CodecDelay from the template codec context
            # even after changing OpusHead. The real headerless fixture starts
            # at zero, so explicitly clear that container delay as well.
            pos = data.index(b'\x56\xaa') + 2
            width = 1
            while not data[pos] & (0x80 >> (width - 1)):
                width += 1
            size = int.from_bytes(data[pos:pos+width], 'big') & ((1 << (7 * width)) - 1)
            self.assertLessEqual(size, 8)
            data[pos+width:pos+width+size] = bytes(size)
        path.write_bytes(data)
        self.source = path
        with av.open(str(path)) as src:
            self.assertFalse(src.streams.audio[0].codec_context.extradata)

    def test_headerless_mono_and_stereo_preserve_clock_payload_and_samples(self):
        for channels in (1, 2):
            with self.subTest(channels=channels):
                self.source = self.root / 'source.webm'
                self.headerless_source(channels=channels)
                original_bytes = self.source.read_bytes()
                result = partial.render(self.config())
                self.assertEqual('partial', result['status'])
                self.assertLess(result['encoded_samples'], 48000)
                original, output = self.decode(self.source), self.decode(self.output)
                self.assertEqual(len(original), len(output))
                self.assertEqual(len(self.decode(self.source, clock=True)), len(self.decode(self.output, clock=True)))
                for seconds in (0, 1, 5, 10):
                    pos = seconds * 48000 * channels
                    self.assertLess(max(abs(a-b) for a, b in zip(original[pos:pos+2000], output[pos:pos+2000])), 1e-6)
                middle = output[round(3.16*48000)*channels:round(3.33*48000)*channels]
                self.assertLess(sum(v*v for v in middle) / len(middle), 1e-6)
                # BBB's normal FFmpeg path uses the native Opus decoder.
                native_original = self.decode(self.source, native=True)
                native_output = self.decode(self.output, native=True)
                self.assertEqual(len(native_original), len(native_output))
                self.assertLess(max(abs(a-b) for a, b in zip(native_original[:48000], native_output[:48000])), 1e-6)
                self.assertEqual(original_bytes, self.source.read_bytes())

    def test_headerless_gaps_and_nonzero_container_delay_are_rejected(self):
        for options in ({'gap': True}, {'keep_delay': True}):
            with self.subTest(options=options):
                self.source = self.root / 'source.webm'
                self.headerless_source(**options)
                with self.assertRaisesRegex(partial.Unsupported, 'non-continuous timestamps'):
                    partial.render(self.config())
                self.assertFalse(self.output.exists())

    def config(self, masks=None, effect=None):
        return {'source': str(self.source), 'output': str(self.output), 'ffmpeg': 'ffmpeg', 'ffprobe': 'ffprobe',
                'masks': masks or [{'start_ms': 3123, 'end_ms': 3373}],
                'effect': effect or "aeval=exprs='if(gte(t,3.123)*lt(t,3.373),0,val(ch))':c=same"}

    def decode(self, path, clock=False, native=False):
        values = array.array('f')
        effect = ['-af', 'aresample=async=480:first_pts=0:flags=res'] if clock else []
        values.frombytes(ff(*([] if native else ['-c:a', 'libopus']), '-i', path, *effect, '-f', 'f32le', '-'))
        return values

    def test_partial_mute_preserves_clock_samples_copied_packets_and_original(self):
        original_bytes = self.source.read_bytes()
        result = partial.render(self.config())
        self.assertEqual('partial', result['status'])
        self.assertLess(result['encoded_samples'], 48000)
        self.assertLess(result['decoded_samples'], 48000)
        original, output = self.decode(self.source), self.decode(self.output)
        self.assertEqual(len(original), len(output))
        self.assertEqual(len(self.decode(self.source, clock=True)), len(self.decode(self.output, clock=True)))
        for seconds in (1, 5, 10):
            pos = seconds * 48000 * 2
            self.assertLess(max(abs(a-b) for a, b in zip(original[pos:pos+2000], output[pos:pos+2000])), 1e-6)
        middle = output[round(3.16*48000)*2:round(3.33*48000)*2]
        self.assertLess(sum(v*v for v in middle) / len(middle), 1e-6)
        self.assertEqual(original_bytes, self.source.read_bytes())

    def test_multiple_beeps_and_mutes_preserve_global_phase_and_channel_layout(self):
        effect = "aeval=exprs='if(gte(t,3.123)*lt(t,3.373),0.12*sin(2*PI*1000*t),if(gte(t,7.007)*lt(t,7.201),0,val(ch)))':c=same"
        masks = [{'start_ms': 3123, 'end_ms': 3373}, {'start_ms': 7007, 'end_ms': 7201}]
        result = partial.render(self.config(masks, effect))
        self.assertLess(result['encoded_samples'], 2*48000)
        x, y = self.decode(self.source), self.decode(self.output)
        self.assertEqual(len(x), len(y))
        segment = y[round(3.16*48000)*2:round(3.33*48000)*2]
        rms = (sum(v*v for v in segment) / len(segment))**0.5
        self.assertAlmostEqual(0.12/2**0.5, rms, delta=0.01)
        # Distinct original stereo channels become the same replacement tone.
        self.assertLess(max(abs(a-b) for a, b in zip(segment[::2], segment[1::2])), 0.005)

    def test_supported_packet_sizes_and_mono(self):
        for frame in (10, 60):
            with self.subTest(frame=frame):
                self.generate(frame=frame, channels=1)
                result = partial.render(self.config())
                self.assertEqual('partial', result['status'])
                self.assertEqual(len(self.decode(self.source)), len(self.decode(self.output)))

    def test_nonstandard_preskip_is_aligned_without_reencoding_other_packets(self):
        self.generate(extra=('-application', 'lowdelay'))
        result = partial.render(self.config())
        self.assertEqual('partial', result['status'])
        original, output = self.decode(self.source), self.decode(self.output)
        self.assertEqual(len(original), len(output))
        pos = 8 * 48000 * 2
        self.assertLess(max(abs(a-b) for a, b in zip(original[pos:pos+2000], output[pos:pos+2000])), 1e-6)

    def decoded_sample_count(self, path):
        # Count PCM through a pipe; don't allocate an entire long recording.
        with subprocess.Popen(['ffmpeg', '-v', 'error', '-nostdin', '-c:a', 'libopus', '-i', str(path),
                               '-f', 'f32le', '-'], stdout=subprocess.PIPE, stderr=subprocess.PIPE) as proc:
            size = sum(len(block) for block in iter(lambda: proc.stdout.read(65536), b''))
            self.assertEqual(0, proc.wait(), proc.stderr.read().decode())
        return size // 4

    def excerpt(self, path, start, duration=0.12):
        values = array.array('f')
        values.frombytes(ff('-c:a', 'libopus', '-ss', start, '-i', path, '-t', duration, '-f', 'f32le', '-'))
        return values

    def test_100_second_beep_is_chunked_and_preserves_samples_seams_and_original_packets(self):
        import av
        masks = [{'start_ms': 3123, 'end_ms': 103670}, {'start_ms': 200007, 'end_ms': 200132}]
        effect = "aeval=exprs='if(gte(t,3.123)*lt(t,103.670),0.12*sin(2*PI*1000*t),if(gte(t,200.007)*lt(t,200.132),0,val(ch)))':c=same"
        for headerless in (False, True):
            with self.subTest(headerless=headerless):
                self.source = self.root / 'source.webm'
                if headerless:
                    self.headerless_source(duration=360)
                else:
                    self.generate(duration=360)
                before = self.source.read_bytes()
                config = self.config(masks, effect)
                _, delay, frame, count = partial.inspect(av, partial.opus_library(), str(self.source))
                windows = partial.plan(masks, frame, delay, count)
                result = partial.render(config)
                self.assertEqual('partial', result['status'])
                self.assertEqual(5, result['encoded_chunks'])
                self.assertLessEqual(result['max_decoded_chunk_samples'], 30 * 48000)
                self.assertLessEqual(result['max_encoded_chunk_samples'], 30 * 48000)
                self.assertLess(result['encoded_samples'], 104 * 48000)
                self.assertEqual(self.decoded_sample_count(self.source), self.decoded_sample_count(self.output))
                # Seams inside the continuous tone must retain its phase and
                # level, without clicks or dropouts from independent encoders.
                seams = [(w[1] * frame - delay) / 48000 for w in windows[:3]]
                for seam in seams:
                    segment = self.excerpt(self.output, seam - 0.06)
                    self.assertGreater(len(segment), 1000)
                    rms = (sum(v*v for v in segment) / len(segment)) ** 0.5
                    self.assertAlmostEqual(0.12 / 2**0.5, rms, delta=0.008)
                    self.assertLess(max(abs(v) for v in segment), 0.16)
                    # 1kHz repeats every 48 samples on both channels.
                    self.assertLess(max(abs(a-b) for a,b in zip(segment, segment[96:])), 0.015)
                for seconds in (1, 150, 300):
                    a, b = self.excerpt(self.source, seconds), self.excerpt(self.output, seconds)
                    self.assertEqual(len(a), len(b))
                    self.assertLess(max(abs(x-y) for x,y in zip(a,b)), 1e-6)
                mute = self.excerpt(self.output, 200.04, 0.06)
                self.assertLess(sum(v*v for v in mute) / len(mute), 1e-6)
                self.assertEqual(before, self.source.read_bytes())

    def test_chunking_other_packet_sizes_and_failure_after_a_completed_chunk(self):
        from unittest.mock import patch
        for frame, channels in ((10, 1), (60, 2)):
            with self.subTest(frame=frame, channels=channels):
                self.generate(frame=frame, channels=channels)
                config = self.config([{'start_ms': 3123, 'end_ms': 6323}],
                    "aeval=exprs='if(gte(t,3.123)*lt(t,6.323),0.12*sin(2*PI*1000*t),val(ch))':c=same")
                with patch.object(partial, 'MAX_CHUNK_SAMPLES', 48000):
                    result = partial.render(config)
                self.assertGreaterEqual(result['encoded_chunks'], 4)
                self.assertLessEqual(result['max_decoded_chunk_samples'], 48000)
                self.assertEqual(len(self.decode(self.source)), len(self.decode(self.output)))
                segment = self.excerpt(self.output, 4, 0.1)
                self.assertAlmostEqual(0.12/2**0.5, (sum(v*v for v in segment)/len(segment))**0.5, delta=0.008)
        self.output.unlink()
        self.generate()
        original_encoder, calls = partial.encode_patch, []
        def fail_second(*args, **kwargs):
            calls.append(1)
            if len(calls) == 2:
                raise partial.Unsupported('second chunk failed')
            return original_encoder(*args, **kwargs)
        with patch.object(partial, 'MAX_CHUNK_SAMPLES', 48000), patch.object(partial, 'encode_patch', side_effect=fail_second):
            with self.assertRaisesRegex(partial.Unsupported, 'second chunk failed'):
                partial.render(self.config([{'start_ms': 3123, 'end_ms': 6323}]))
        self.assertEqual(2, len(calls))
        self.assertFalse(self.output.exists())
        self.assertFalse(list(self.root.glob('opus-patch-*')))

    def test_vorbis_and_video_are_ineligible(self):
        self.generate(codec='libvorbis')
        with self.assertRaises(partial.Unsupported):
            partial.render(self.config())
        self.generate()
        video = self.root / 'video.webm'
        ff('-f', 'lavfi', '-i', 'color=s=32x32:d=12:r=1', '-i', self.source,
           '-c:v', 'libvpx', '-c:a', 'copy', video)
        config = self.config(); config['source'] = str(video)
        with self.assertRaises(partial.Unsupported):
            partial.render(config)
        self.assertFalse(self.output.exists())

    def test_timestamp_gap_is_rejected_without_publishing_output(self):
        self.generate(extra=('-af', r'asetpts=PTS+if(gte(T\,6)\,0.1/TB\,0)'))
        with self.assertRaisesRegex(partial.Unsupported, 'non-continuous'):
            partial.render(self.config())
        self.assertFalse(self.output.exists())

    def test_failed_patch_and_failed_validation_do_not_publish_output(self):
        config = self.config(effect='invalid-filter')
        with self.assertRaises(partial.Unsupported):
            partial.render(config)
        self.assertFalse(self.output.exists())
        from unittest.mock import patch
        with patch.object(partial, 'validate', side_effect=partial.Unsupported('test failure')):
            with self.assertRaises(partial.Unsupported):
                partial.render(self.config())
        self.assertFalse(self.output.exists())
        self.assertFalse(list(self.root.glob('opus-patch-*')))

    def test_cli_reports_fallback_for_malformed_requests(self):
        p = subprocess.run([__import__('sys').executable, str(Path(partial.__file__))], input='{}', capture_output=True, text=True)
        self.assertEqual(0, p.returncode)
        result = json.loads(p.stdout)
        self.assertEqual('fallback', result['status'])
        self.assertEqual('KeyError', result['error_type'])
        self.assertIn('KeyError', result['reason'])
        self.assertIn('Traceback', p.stderr)


if __name__ == '__main__':
    unittest.main()
