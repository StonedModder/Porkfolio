"""
Analyze a PS5 WebM file and dump EBML structure to videoLog.json.
Run: python scripts/analyze-webm.py
"""
import json, struct, sys, os
from tkinter import Tk, filedialog

# ── EBML element ID catalog (WebM subset) ────────────────────────────────────
EBML_NAMES = {
    0x1A45DFA3: "EBML",
    0x4286:     "EBMLVersion",
    0x42F7:     "EBMLReadVersion",
    0x42F2:     "EBMLMaxIDLength",
    0x42F3:     "EBMLMaxSizeLength",
    0x4282:     "DocType",
    0x4287:     "DocTypeVersion",
    0x4285:     "DocTypeReadVersion",
    0x18538067: "Segment",
    0x114D9B74: "SeekHead",
    0x4DBB:     "Seek",
    0x53AB:     "SeekID",
    0x53AC:     "SeekPosition",
    0x1549A966: "Info",
    0x2AD7B1:   "TimestampScale",
    0x4489:     "Duration",
    0x4461:     "DateUTC",
    0x4D80:     "MuxingApp",
    0x5741:     "WritingApp",
    0x1654AE6B: "Tracks",
    0xAE:       "TrackEntry",
    0xD7:       "TrackNumber",
    0x73C5:     "TrackUID",
    0x83:       "TrackType",
    0x86:       "CodecID",
    0x63A2:     "CodecPrivate",
    0xE0:       "Video",
    0xB0:       "PixelWidth",
    0xBA:       "PixelHeight",
    0x54B0:     "DisplayWidth",
    0x54BA:     "DisplayHeight",
    0xE1:       "Audio",
    0xB5:       "SamplingFrequency",
    0x9F:       "Channels",
    0x6264:     "BitDepth",
    0x1F43B675: "Cluster",
    0xE7:       "Timestamp",
    0xA3:       "SimpleBlock",
    0xA0:       "BlockGroup",
    0xA1:       "Block",
    0x1C53BB6B: "Cues",
    0xBB:       "CuePoint",
    0xB3:       "CueTime",
    0xB7:       "CueTrackPositions",
    0xF7:       "CueTrack",
    0xF1:       "CueClusterPosition",
    0x1043A770: "Chapters",
    0x1254C367: "Tags",
}

MASTER_IDS = {
    0x1A45DFA3, 0x18538067, 0x114D9B74, 0x4DBB, 0x1549A966,
    0x1654AE6B, 0xAE, 0xE0, 0xE1, 0x1F43B675, 0xA0,
    0x1C53BB6B, 0xBB, 0xB7, 0x1043A770, 0x1254C367,
}

# Track types
TRACK_TYPES = {1: "video", 2: "audio", 3: "complex", 0x10: "logo", 0x11: "subtitle", 0x12: "buttons", 0x20: "control"}


def read_vint(data, pos):
    """Read an EBML variable-length integer. Returns (value, width, is_unknown)."""
    if pos >= len(data):
        return None, 0, False
    b = data[pos]
    if b == 0:
        return None, 0, False
    width = 1
    mask = 0x80
    while mask and not (b & mask):
        width += 1
        mask >>= 1
    if pos + width > len(data):
        return None, 0, False
    val = b & (mask - 1)
    all_ones = (mask - 1)  # data bits in first byte all set
    is_all_ones = (val == all_ones)
    for i in range(1, width):
        val = (val << 8) | data[pos + i]
        if data[pos + i] != 0xFF:
            is_all_ones = False
    is_unknown = is_all_ones  # "unknown" size sentinel
    return val, width, is_unknown


def read_element_id(data, pos):
    """Read an EBML element ID (includes leading bits). Returns (id, width)."""
    if pos >= len(data):
        return None, 0
    b = data[pos]
    if b == 0:
        return None, 0
    width = 1
    mask = 0x80
    while mask and not (b & mask):
        width += 1
        mask >>= 1
    if pos + width > len(data):
        return None, 0
    val = 0
    for i in range(width):
        val = (val << 8) | data[pos + i]
    return val, width


def parse_elements(data, offset, end, depth=0, max_depth=4, results=None, cluster_limit=50):
    """Recursively parse EBML elements. Returns list of element dicts."""
    if results is None:
        results = []
    cluster_count = 0

    pos = offset
    while pos < end:
        elem_start = pos

        eid, id_w = read_element_id(data, pos)
        if eid is None or id_w == 0:
            break
        pos += id_w

        size, size_w, is_unknown = read_vint(data, pos)
        if size is None:
            break
        pos += size_w

        name = EBML_NAMES.get(eid, f"Unknown(0x{eid:X})")
        actual_size = size if not is_unknown else (end - pos)

        elem = {
            "name": name,
            "id": f"0x{eid:X}",
            "offset": elem_start,
            "offset_hex": f"0x{elem_start:X}",
            "header_size": id_w + size_w,
            "declared_size": "unknown" if is_unknown else size,
            "declared_end": "unknown" if is_unknown else (pos + size),
            "declared_end_hex": "unknown" if is_unknown else f"0x{pos + size:X}",
        }

        # For Segment, add extra analysis
        if eid == 0x18538067:
            elem["file_size"] = len(data)
            elem["data_beyond_declared_end"] = "N/A" if is_unknown else (len(data) - (pos + size))
            elem["size_vs_filesize_pct"] = "N/A" if is_unknown else f"{(size / len(data)) * 100:.2f}%"
            elem["diagnosis"] = (
                "OK — unknown size (will scan to EOF)"
                if is_unknown
                else (
                    f"BAD — declared size {size} bytes ({size/1024:.1f} KB) but file has "
                    f"{len(data) - pos} bytes of data remaining ({(len(data)-pos)/1024/1024:.2f} MB). "
                    f"ffmpeg stops at byte {pos+size} and misses the rest!"
                    if size < (len(data) - pos) * 0.9
                    else "OK — size looks reasonable"
                )
            )

        # For Clusters, count and limit
        if eid == 0x1F43B675:
            cluster_count += 1
            elem["cluster_index"] = cluster_count
            if cluster_count > cluster_limit:
                elem["note"] = f"(skipping further clusters; {cluster_limit} shown)"
                results.append(elem)
                # Skip to end — we've seen enough clusters
                if is_unknown:
                    break
                pos += actual_size
                continue

        # Read scalar values for small non-master elements
        if eid not in MASTER_IDS and actual_size <= 8 and actual_size > 0 and (pos + actual_size) <= len(data):
            raw = data[pos:pos + actual_size]
            # Try unsigned int
            elem["raw_hex"] = raw.hex()
            if actual_size <= 8:
                elem["value_uint"] = int.from_bytes(raw, "big")

        # String values for known string elements
        if eid in (0x4282, 0x4D80, 0x5741, 0x86) and actual_size > 0 and actual_size < 256:
            try:
                elem["value_str"] = data[pos:pos + actual_size].rstrip(b'\x00').decode("utf-8", errors="replace")
            except:
                pass

        # Track type
        if eid == 0x83 and actual_size <= 8 and actual_size > 0:
            tv = int.from_bytes(data[pos:pos + actual_size], "big")
            elem["track_type_name"] = TRACK_TYPES.get(tv, "unknown")

        # Recurse into master elements (but not too deep, and not into Clusters beyond limit)
        if eid in MASTER_IDS and depth < max_depth:
            child_end = pos + actual_size if not is_unknown else end
            children = []
            # For Clusters, only parse first few in detail
            if eid == 0x1F43B675:
                if cluster_count <= 3:
                    parse_elements(data, pos, min(child_end, pos + 64 * 1024), depth + 1, max_depth, children, cluster_limit)
                    elem["children_sample"] = children
                    elem["note"] = "showing first 64KB of cluster content"
            else:
                parse_elements(data, pos, child_end, depth + 1, max_depth, children, cluster_limit)
                elem["children"] = children

        results.append(elem)

        if is_unknown and eid != 0x18538067:
            break  # can't advance past unknown-size non-Segment
        pos += actual_size

    return results


def analyze(filepath):
    """Full analysis of a WebM/MKV file."""
    data = open(filepath, "rb").read()
    fsize = len(data)

    report = {
        "file": os.path.basename(filepath),
        "full_path": filepath,
        "file_size_bytes": fsize,
        "file_size_mb": round(fsize / 1024 / 1024, 2),
    }

    # ── Raw hex dump of first 128 bytes ───────────────────────────────────────
    report["hex_first_128_bytes"] = " ".join(f"{b:02X}" for b in data[:128])

    # ── Locate key structural offsets manually ────────────────────────────────
    # EBML header
    ebml_ok = data[:4] == b'\x1A\x45\xDF\xA3'
    report["ebml_header_present"] = ebml_ok

    # Find Segment element
    seg_pos = -1
    for i in range(min(64, fsize - 4)):
        if data[i:i+4] == b'\x18\x53\x80\x67':
            seg_pos = i
            break
    report["segment_offset"] = seg_pos
    report["segment_offset_hex"] = f"0x{seg_pos:X}" if seg_pos >= 0 else None

    if seg_pos >= 0:
        size_val, size_w, is_unk = read_vint(data, seg_pos + 4)
        report["segment_size_field"] = {
            "offset": seg_pos + 4,
            "width_bytes": size_w,
            "raw_hex": data[seg_pos+4:seg_pos+4+size_w].hex(),
            "decoded_value": "unknown" if is_unk else size_val,
            "is_unknown_marker": is_unk,
            "implied_data_end": "EOF" if is_unk else (seg_pos + 4 + size_w + size_val),
            "actual_file_end": fsize,
        }
        if not is_unk:
            implied_end = seg_pos + 4 + size_w + size_val
            report["segment_size_field"]["bytes_past_declared_end"] = fsize - implied_end
            report["segment_size_field"]["coverage_pct"] = f"{(size_val / (fsize - seg_pos - 4 - size_w)) * 100:.2f}%"

    # ── Find all Cluster positions ────────────────────────────────────────────
    cluster_offsets = []
    search_from = 0
    while True:
        idx = data.find(b'\x1F\x43\xB6\x75', search_from)
        if idx == -1:
            break
        cluster_offsets.append(idx)
        search_from = idx + 4
    report["cluster_count"] = len(cluster_offsets)
    report["cluster_offsets_first_10"] = [{"offset": o, "hex": f"0x{o:X}"} for o in cluster_offsets[:10]]
    if len(cluster_offsets) > 10:
        report["cluster_offsets_last_3"] = [{"offset": o, "hex": f"0x{o:X}"} for o in cluster_offsets[-3:]]

    # ── Segment size vs first Cluster ─────────────────────────────────────────
    if seg_pos >= 0 and not is_unk and cluster_offsets:
        seg_data_start = seg_pos + 4 + size_w
        seg_data_end = seg_data_start + size_val
        first_cluster = cluster_offsets[0]
        report["critical_check"] = {
            "segment_data_range": f"0x{seg_data_start:X} – 0x{seg_data_end:X}",
            "first_cluster_at": f"0x{first_cluster:X}",
            "first_cluster_inside_segment": first_cluster < seg_data_end,
            "clusters_inside_segment": sum(1 for c in cluster_offsets if c < seg_data_end),
            "clusters_outside_segment": sum(1 for c in cluster_offsets if c >= seg_data_end),
            "verdict": (
                "ALL CLUSTERS ARE OUTSIDE THE DECLARED SEGMENT — ffmpeg will never see them!"
                if all(c >= seg_data_end for c in cluster_offsets)
                else (
                    f"Only {sum(1 for c in cluster_offsets if c < seg_data_end)} of "
                    f"{len(cluster_offsets)} clusters inside Segment"
                )
            ),
        }

    # ── Full EBML tree (limited depth/count) ──────────────────────────────────
    report["ebml_tree"] = parse_elements(data, 0, fsize, max_depth=4, cluster_limit=10)

    return report


def main():
    root = Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    filepath = filedialog.askopenfilename(
        title="Select a PS5 WebM file to analyze",
        filetypes=[("WebM files", "*.webm"), ("MKV files", "*.mkv"), ("All files", "*.*")],
    )
    root.destroy()
    if not filepath:
        print("No file selected.")
        return

    print(f"Analyzing: {filepath}")
    print(f"Size: {os.path.getsize(filepath) / 1024 / 1024:.2f} MB")

    report = analyze(filepath)

    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "videoLog.json")
    out = os.path.normpath(out)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    print(f"\nDumped to: {out}")
    print(f"Segment offset: {report.get('segment_offset_hex', '?')}")
    sf = report.get("segment_size_field", {})
    print(f"Segment size: {sf.get('decoded_value', '?')} (raw: {sf.get('raw_hex', '?')})")
    print(f"Clusters found: {report.get('cluster_count', 0)}")
    if "critical_check" in report:
        print(f"\n*** {report['critical_check']['verdict']} ***")
    print(f"\nFull details in videoLog.json — paste it back to me.")


if __name__ == "__main__":
    main()
