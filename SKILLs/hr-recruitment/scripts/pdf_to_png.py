#!/usr/bin/env python3
"""
Extract embedded image from an image-based PDF and convert to PNG.

Usage:
    python pdf_to_png.py <input.pdf> <output.png>

This script handles PDFs where pypdf text extraction fails (image-based/scanned).
It extracts the first embedded XObject image and writes a valid PNG file using
only stdlib modules (struct, zlib) — no PIL/Pillow dependency.

Designed for the LobsterAI runtime where pip install may be broken.
"""

import sys
import struct
import zlib
from pathlib import Path


def extract_image_data(pdf_path: str) -> tuple:
    """Extract raw RGB image data from the first XObject image in a PDF.
    
    Returns: (data: bytes, width: int, height: int) or raises.
    """
    from pypdf import PdfReader
    
    reader = PdfReader(pdf_path)
    
    for page in reader.pages:
        resources = page.get('/Resources', {})
        xobjs = resources.get('/XObject', {})
        
        for key in xobjs:
            obj = xobjs[key].get_object()
            if obj.get('/Subtype') == '/Image':
                width = int(obj['/Width'])
                height = int(obj['/Height'])
                color_space = str(obj.get('/ColorSpace', '/DeviceRGB'))
                bits = int(obj.get('/BitsPerComponent', 8))
                
                data = obj.get_data()
                
                # Determine channels
                if 'Gray' in color_space:
                    channels = 1
                elif 'CMYK' in color_space:
                    channels = 4
                else:
                    channels = 3  # RGB
                
                expected = width * height * channels
                if len(data) >= expected:
                    return data[:expected], width, height, channels
    
    raise ValueError("No valid image XObject found in PDF")


def write_png(filename: str, width: int, height: int, rgb_data: bytes, channels: int = 3):
    """Write raw pixel data as a valid PNG file.
    
    Uses only stdlib (struct + zlib). No PIL needed.
    """
    def make_chunk(chunk_type: bytes, data: bytes) -> bytes:
        c = chunk_type + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    
    # PNG color type: 0=grayscale, 2=RGB, 6=RGBA
    if channels == 1:
        color_type = 0
    elif channels == 3:
        color_type = 2
    elif channels == 4:
        color_type = 6
    else:
        color_type = 2
    
    # Build raw image data with filter byte 0 (None) per row
    stride = width * channels
    raw_rows = bytearray()
    for y in range(height):
        raw_rows.append(0)  # filter byte: None
        row_start = y * stride
        raw_rows.extend(rgb_data[row_start:row_start + stride])
    
    compressed = zlib.compress(bytes(raw_rows), 9)
    
    # PNG signature
    signature = b'\x89PNG\r\n\x1a\n'
    
    # IHDR chunk
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, color_type, 0, 0, 0)
    
    with open(filename, 'wb') as f:
        f.write(signature)
        f.write(make_chunk(b'IHDR', ihdr_data))
        f.write(make_chunk(b'IDAT', compressed))
        f.write(make_chunk(b'IEND', b''))


def main():
    if len(sys.argv) < 3:
        print("Usage: python pdf_to_png.py <input.pdf> <output.png>")
        sys.exit(1)
    
    pdf_path = sys.argv[1]
    png_path = sys.argv[2]
    
    if not Path(pdf_path).exists():
        print(f"Error: PDF not found: {pdf_path}")
        sys.exit(1)
    
    try:
        data, width, height, channels = extract_image_data(pdf_path)
        print(f"Extracted image: {width}x{height}, {channels} channels, {len(data)} bytes")
        
        write_png(png_path, width, height, data, channels)
        
        # Verify
        with open(png_path, 'rb') as f:
            header = f.read(8)
        
        import os
        size = os.path.getsize(png_path)
        valid = header == b'\x89PNG\r\n\x1a\n'
        
        print(f"PNG written: {png_path} ({size} bytes, valid={valid})")
        
        if not valid:
            print("ERROR: PNG signature invalid!", file=sys.stderr)
            sys.exit(1)
            
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
