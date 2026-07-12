import sys
path = r'C:\Users\jarch\OneDrive\Pictures\NPXS40087\20260303_225318_00723363.webm'
with open(path, 'rb') as f:
    f.seek(168788)
    pos = 168788
    found = False
    while not found:
        chunk = f.read(65536)
        if not chunk:
            print('All zeros to EOF!')
            break
        for i, b in enumerate(chunk):
            if b != 0:
                fpos = pos + i
                print('First non-zero at: %d (0x%X)' % (fpos, fpos))
                print('Zero gap from 168788: %d bytes (%.1f KB)' % (fpos - 168788, (fpos - 168788) / 1024))
                f.seek(fpos)
                ctx = f.read(128)
                print('Hex:', ' '.join('%02X' % x for x in ctx))
                if ctx[0:4] == b'\x1F\x43\xB6\x75':
                    print('>>> THIS IS A CLUSTER ELEMENT ID!')
                else:
                    print('>>> NOT a standard Cluster ID at this position')
                found = True
                break
        pos += len(chunk)
