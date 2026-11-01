"""Packet-preserving Opus edits. Optional accelerator; never writes raw files.

Only continuous, fixed-duration Opus in an audio-only WebM is eligible. Decode
bounded context with libopus, encode guarded patches with FFmpeg, and remux all
other packets unchanged. Any unsupported condition uses the existing renderer.
"""
import array
import ctypes as ct
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile

RATE = 48000
PATCH_DELAY = 312  # FFmpeg libopus, application=audio; checked against its header.


class Unsupported(Exception):
    pass


def require(ok, reason):
    if not ok:
        raise Unsupported(reason)


def opus_library():
    lib = ct.CDLL('libopus.so.0')
    lib.opus_decoder_create.argtypes = [ct.c_int, ct.c_int, ct.POINTER(ct.c_int)]
    lib.opus_decoder_create.restype = ct.c_void_p
    lib.opus_decoder_destroy.argtypes = [ct.c_void_p]
    lib.opus_decode_float.argtypes = [ct.c_void_p, ct.c_void_p, ct.c_int, ct.POINTER(ct.c_float), ct.c_int, ct.c_int]
    lib.opus_decode_float.restype = ct.c_int
    lib.opus_packet_get_nb_samples.argtypes = [ct.c_void_p, ct.c_int, ct.c_int]
    lib.opus_packet_get_nb_samples.restype = ct.c_int
    return lib


def header(stream):
    data = stream.codec_context.extradata
    require(stream.codec_context.name == 'opus' and data and len(data) == 19 and
            data[:8] == b'OpusHead' and data[8] == 1 and data[9] in (1, 2) and
            data[16:19] == b'\0\0\0' and stream.codec_context.sample_rate == RATE,
            'unsupported Opus configuration')
    delay = int.from_bytes(data[10:12], 'little')
    require(delay <= 3840, 'unsupported pre-skip')
    return data[9], delay


def audio(container):
    require(len(container.streams) == 1 and container.streams[0].type == 'audio', 'audio-only WebM required')
    stream = container.streams[0]
    require('webm' in container.format.name, 'WebM required')
    return stream


def packet_samples(lib, packet):
    data = bytes(packet)
    return lib.opus_packet_get_nb_samples(data, len(data), RATE)


def inspect(av, lib, source):
    count, frame = 0, None
    with av.open(source) as container:
        stream = audio(container)
        channels, delay = header(stream)
        for packet in container.demux(stream):
            if not packet.size:
                continue
            size = packet_samples(lib, packet)
            frame = size if frame is None else frame
            require(frame in (480, 960, 2880) and size == frame, 'variable or unsupported packet duration')
            expected = (count * frame - delay) / RATE
            require(packet.pts is not None and packet.dts == packet.pts and
                    abs(float(packet.pts * packet.time_base) - expected) <= 0.0011,
                    'non-continuous timestamps')
            require(packet.duration and abs(float(packet.duration * packet.time_base) - frame / RATE) <= 0.0011,
                    'unsupported packet timing')
            count += 1
    require(count > 2, 'source too short')
    return channels, delay, frame, count


def side_data_check(probe, source, count, delay, frame):
    # PyAV 9/11 preserve side data when copying packets, but cannot inspect it.
    # Reject interior trimming, which would invalidate the sample-clock mapping.
    args = [probe, '-v', 'error', '-select_streams', 'a:0', '-show_packets',
            '-show_entries', 'packet=pts:packet_side_data=side_data_type,skip_samples,discard_padding',
            '-of', 'compact=p=1:nk=0', source]
    index, trimming = 0, []
    with tempfile.TemporaryFile() as errors:
        with subprocess.Popen(args, stdout=subprocess.PIPE, stderr=errors, text=True) as proc:
            valid = True
            for line in proc.stdout:
                if not line.startswith('packet|'):
                    valid = False
                    continue
                if 'side_data_type=' in line:
                    fields = dict(part.rsplit(':', 1)[-1].split('=', 1) for part in line.strip().split('|') if '=' in part)
                    skip = fields.get('skip_samples', '0')
                    pad = fields.get('discard_padding', '0')
                    trimming.append((index, fields.get('side_data_type'), skip, pad))
                    valid &= fields.get('side_data_type') == 'Skip Samples' and (
                        index == 0 and skip == str(delay) and pad == '0' or
                        index == count - 1 and skip == '0' and pad.isdigit() and int(pad) <= frame)
                index += 1
            require(proc.wait() == 0 and index == count and valid, 'unsupported packet trimming')
    return trimming


def plan(masks, frame, delay, count):
    windows = []
    guard = math.ceil(0.08 * RATE / frame)
    context = math.ceil(0.1 * RATE / frame)
    previous_start = -1
    for mask in masks:
        start, end = mask['start_ms'], mask['end_ms']
        require(isinstance(start, (float, int)) and isinstance(end, (float, int)) and
                math.isfinite(start) and math.isfinite(end) and 0 <= start < end and start >= previous_start, 'invalid edit range')
        previous_start = start
        n = math.floor((start * 48 + delay) / frame) - guard
        j = math.ceil((end * 48 + delay) / frame) + guard
        # Preserve original first/last packets and their pre-skip/end padding.
        require(n > context + 1 and j < count - context - 2, 'edit near source edge')
        if windows and n <= windows[-1][1] + 2 * context + 3:
            windows[-1][1] = max(windows[-1][1], j)
        else:
            windows.append([n, j])
    require(windows and len(windows) <= 32 and sum(b-a for a, b in windows) < count * 0.4,
            'whole-file rendering is preferable')
    result = []
    for n, j in windows:
        begin = (n - context) * frame + PATCH_DELAY - delay
        end = (j + 2) * frame + PATCH_DELAY - delay
        q0 = math.floor((begin + delay) / frame) - context
        q1 = math.ceil((end + delay) / frame)
        require(begin >= 0 and q0 >= 0 and q1 < count and end - begin <= 30 * RATE, 'patch context too large')
        result.append((n, j, context, begin, end, q0, q1))
    return result


def encode_patch(av, config, pcm, window, directory, channels, delay, frame, lib):
    n, j, context, begin, end, q0, q1 = window
    offset = begin - (q0 * frame - delay)
    require(0 <= offset and offset + end - begin <= len(pcm) // channels, 'incomplete decoder context')
    raw = pcm[offset * channels:(offset + end - begin) * channels]
    path = str(Path(directory) / 'patch.webm')
    effect = f"asetpts=PTS+({begin}/{RATE})/TB,{config['effect']},asetpts=PTS-STARTPTS"
    result = subprocess.run([config['ffmpeg'], '-nostdin', '-v', 'error', '-y', '-f', 'f32le',
        '-ar', str(RATE), '-ac', str(channels), '-i', '-', '-af', effect, '-c:a', 'libopus',
        '-application', 'audio', '-frame_duration', str(frame / 48), '-b:a', '96k', path],
        input=raw.tobytes(), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    require(result.returncode == 0, 'patch encoder failed')
    replacements = {}
    with av.open(path) as container:
        stream = audio(container)
        require(header(stream) == (channels, PATCH_DELAY), 'unexpected patch encoder delay')
        for i, packet in enumerate(p for p in container.demux(stream) if p.size):
            if context <= i < context + j - n:
                require(packet_samples(lib, packet) == frame, 'unexpected patch frame size')
                replacements[n + i - context] = bytes(packet)
    require(len(replacements) == j - n, 'incomplete encoded patch')
    return replacements, len(raw) // channels


def remux(av, source, output, replacements):
    with av.open(source) as src, av.open(output, 'w', format='webm') as target:
        stream = audio(src)
        out = target.add_stream_from_template(stream) if hasattr(target, 'add_stream_from_template') else target.add_stream(template=stream)
        index = 0
        for packet in src.demux(stream):
            if not packet.size:
                continue
            if index in replacements:
                patch = av.Packet(replacements[index])
                patch.pts, patch.dts, patch.time_base = packet.pts, packet.dts, packet.time_base
                patch.is_keyframe = True
            else:
                patch = packet  # Retains original side data, including end padding.
            patch.stream = out
            target.mux(patch)
            index += 1


def validate(av, lib, source, output, replacements, count):
    with av.open(source) as src, av.open(output) as dst:
        a, b = audio(src), audio(dst)
        require(a.codec_context.extradata == b.codec_context.extradata, 'output codec configuration changed')
        packets_a = (p for p in src.demux(a) if p.size)
        packets_b = (p for p in dst.demux(b) if p.size)
        seen = 0
        for old in packets_a:
            new = next(packets_b, None)
            require(new is not None and (old.pts * old.time_base, old.dts * old.time_base, old.duration * old.time_base) ==
                    (new.pts * new.time_base, new.dts * new.time_base, new.duration * new.time_base), 'output packet clock changed')
            require(bytes(new) == replacements.get(seen, bytes(old)) and packet_samples(lib, new) == packet_samples(lib, old),
                    'output packet payload changed')
            seen += 1
        require(seen == count and next(packets_b, None) is None, 'output packet count changed')


def render(config):
    import av  # Optional OS package; absence is a normal fallback condition.
    require(sys.byteorder == 'little', 'unsupported byte order')
    lib = opus_library()
    source, output = config['source'], config['output']
    before = os.stat(source)
    channels, delay, frame, count = inspect(av, lib, source)
    trimming = side_data_check(config['ffprobe'], source, count, delay, frame)
    windows = plan(config['masks'], frame, delay, count)
    replacements, decoded, encoded = {}, 0, 0
    with tempfile.TemporaryDirectory(prefix='opus-patch-', dir=str(Path(output).parent)) as directory:
        with av.open(source) as container:
            stream = audio(container)
            wi, pcm, state = 0, array.array('f'), None
            buffer = (ct.c_float * (5760 * channels))()
            try:
                for i, packet in enumerate(p for p in container.demux(stream) if p.size):
                    if wi == len(windows):
                        break
                    window = windows[wi]
                    if window[5] <= i < window[6]:
                        if state is None:
                            error = ct.c_int()
                            state = lib.opus_decoder_create(RATE, channels, ct.byref(error))
                            require(state and error.value == 0, 'decoder unavailable')
                        data = bytes(packet)
                        size = lib.opus_decode_float(state, data, len(data), buffer, 5760, 0)
                        require(size == frame, 'decoder frame length changed')
                        pcm.frombytes(ct.string_at(buffer, size * channels * 4))
                        decoded += size
                    if i + 1 == window[6]:
                        patch, size = encode_patch(av, config, pcm, window, directory, channels, delay, frame, lib)
                        replacements.update(patch)
                        encoded += size
                        lib.opus_decoder_destroy(state)
                        state, pcm = None, array.array('f')
                        wi += 1
                require(wi == len(windows), 'source ended during patch rendering')
            finally:
                if state:
                    lib.opus_decoder_destroy(state)
        temp = str(Path(directory) / 'result.webm')
        remux(av, source, temp, replacements)
        validate(av, lib, source, temp, replacements, count)
        require(trimming == side_data_check(config['ffprobe'], temp, count, delay, frame), 'output trimming changed')
        after = os.stat(source)
        require((before.st_size, before.st_mtime_ns, before.st_ctime_ns) == (after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'source changed')
        os.replace(temp, output)
    return {'status': 'partial', 'total_packets': count, 'reencoded_packets': len(replacements),
            'decoded_samples': decoded, 'encoded_samples': encoded}


if __name__ == '__main__':
    try:
        result = render(json.load(sys.stdin))
    except Exception as error:  # An optional accelerator must not disable raw saving.
        result = {'status': 'fallback', 'reason': str(error) if isinstance(error, Unsupported) else 'accelerator unavailable or failed'}
    print(json.dumps(result))
