import asyncio
import websockets
import struct
import time
import math

# --- Cấu hình theo SSOT ---
MAGIC_NUMBER = 0xABCD1234
EXPECTED_PACKET_SIZE = 7744
BATCH_HEADER_SIZE = 16
AUDIO_FRAME_SIZE = 1932
FRAME_SIZE = 480

HEADER_FORMAT = "<IB3xII"
FRAME_FORMAT = f"<Iff{FRAME_SIZE}h{FRAME_SIZE}h"

def create_volume_bar(max_val, length=30):
    """Tạo thanh hiển thị âm lượng trực quan"""
    # max_val của int16 là 32768
    filled_length = int(length * max_val / 20000) # Điều chỉnh 20000 tùy độ nhạy mic
    if filled_length > length: filled_length = length
    bar = '█' * filled_length + '-' * (length - filled_length)
    return f"[{bar}] {max_val:>5}"

async def handle_client(websocket):
    print(f"Thiết bị đã kết nối: {websocket.remote_address}")

    try:
        async for message in websocket:
            if not isinstance(message, bytes) or len(message) != EXPECTED_PACKET_SIZE:
                continue

            # 1. Parse Header
            header_data = message[:BATCH_HEADER_SIZE]
            magic, version, batch_seq, timestamp_ms = struct.unpack(HEADER_FORMAT, header_data)

            if magic != MAGIC_NUMBER: continue

            # 2. Lấy frame cuối cùng trong batch để log (giảm tải màn hình)
            # Mỗi batch có 4 frames
            last_frame_offset = BATCH_HEADER_SIZE + (AUDIO_FRAME_SIZE * 3)
            frame_data = message[last_frame_offset : last_frame_offset + AUDIO_FRAME_SIZE]
            unpacked_frame = struct.unpack(FRAME_FORMAT, frame_data)

            # raw_pcm nằm từ chỉ số 3 đến 3+480 trong unpacked_frame
            raw_pcm = unpacked_frame[3 : 3 + FRAME_SIZE]
            vad_prob = unpacked_frame[1]

            # 3. Tính biên độ dao động (Peak)
            # Tìm giá trị tuyệt đối lớn nhất trong 480 samples
            peak = max(abs(sample) for sample in raw_pcm)

            # 4. Hiển thị log
            # Cứ mỗi 5 batch (~200ms) thì in một lần để dễ nhìn
            if batch_seq % 5 == 0:
                volume_visual = create_volume_bar(peak)
                print(f"Batch: {batch_seq:<5} | VAD: {vad_prob:.2f} | {volume_visual}", end='\r')

    except websockets.ConnectionClosed:
        print("\n❌ Thiết bị đã ngắt kết nối")

async def main():
    server = await websockets.serve(handle_client, "0.0.0.0", 8080)
    print("Server đang lắng nghe tại ws://0.0.0.0:8080")
    await server.wait_closed()

if __name__ == "__main__":
    asyncio.run(main())
