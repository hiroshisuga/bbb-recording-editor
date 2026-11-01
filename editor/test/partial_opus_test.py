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

    def test_neighboring_edits_share_context_and_long_windows_are_rejected(self):
        windows = partial.plan([{'start_ms': 3000, 'end_ms': 3100}, {'start_ms': 3150, 'end_ms': 3250}], 960, 312, 3001)
        self.assertEqual(1, len(windows))
        with self.assertRaises(partial.Unsupported):
            partial.plan([{'start_ms': 3000, 'end_ms': 40000}], 960, 312, 10001)


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

    def generate(self, codec='libopus', frame=20, channels=2, extra=()):
        ff('-f', 'lavfi', '-i', 'aevalsrc=0.12*sin(2*PI*(220*t+3*t*t))|0.12*sin(2*PI*(370*t+5*t*t)):s=48000:d=12',
           '-ac', channels, '-c:a', codec, *(['-frame_duration', frame] if codec == 'libopus' else []), *extra, self.source)

    def config(self, masks=None, effect=None):
        return {'source': str(self.source), 'output': str(self.output), 'ffmpeg': 'ffmpeg', 'ffprobe': 'ffprobe',
                'masks': masks or [{'start_ms': 3123, 'end_ms': 3373}],
                'effect': effect or "aeval=exprs='if(gte(t,3.123)*lt(t,3.373),0,val(ch))':c=same"}

    def decode(self, path, clock=False):
        values = array.array('f')
        effect = ['-af', 'aresample=async=480:first_pts=0:flags=res'] if clock else []
        values.frombytes(ff('-c:a', 'libopus', '-i', path, *effect, '-f', 'f32le', '-'))
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
        self.assertEqual('fallback', json.loads(p.stdout)['status'])


if __name__ == '__main__':
    unittest.main()
