import struct
from importlib.resources import read_binary

import ndef

from . import templates

MIME_TYPE = "application/jp.co.bandai.tamagotchiapp"
TIMEOUT_SECONDS = 35

MAGIC_HEADER = b"TAMAGO"


def create_handshake_message() -> ndef.Record:
    payload = read_binary(templates, "send_start.bin")
    padding = len(payload) % 4

    return ndef.Record(MIME_TYPE, "", data=payload + b"\x00" * padding)


def create_download_message(extracted_data: bytes, mode: int = 0) -> ndef.Record:
    preamble = read_binary(templates, "send_download.bin")
    header = struct.pack("<BBBBBBH", 3, 0, 0, 0, 1, 0, len(extracted_data))

    padding = ((len(extracted_data) + 256) + 2) % 4
    payload = bytearray(preamble + header + extracted_data + b"\x00" * 2 + b"\x00" * padding)
    total_size = len(payload) - padding

    struct.pack_into("<H", payload, 72, total_size)

    payload[132] = 0x03 if mode != 0 else 0x01

    checksum = sum(payload[0 : total_size - 2]) & 0xFFFF
    struct.pack_into("<H", payload, total_size - 2, checksum)

    return ndef.Record(MIME_TYPE, "", data=bytes(payload))


def parse_response(ndef_message: list[ndef.Record]) -> dict[str, str] | None:
    if not ndef_message or len(ndef_message) == 0:
        return None

    record = ndef_message[0]

    if record.type != MIME_TYPE:
        return None

    payload = record.data

    if len(payload) < 140:  # Minimum size to contain all fields
        return None

    device_id_bytes = payload[96:112]
    birth_date_bytes = payload[138:140]

    device_id_parts = []
    for i in range(0, 16, 2):
        hex_str = f"{device_id_bytes[i]:02x}{device_id_bytes[i + 1]:02x}"
        device_id_parts.append(hex_str)
    device_id = "-".join(device_id_parts).upper()

    birth_date = f"{birth_date_bytes[0]:02d}{birth_date_bytes[1]:02d}"

    return {
        "device_id": device_id,
        "birth_date": birth_date,
        "raw_payload": payload,
    }


def verify_checksum(payload: bytes) -> bool:
    if len(payload) < 3:
        return False

    calculated = sum(payload[:-2]) & 0xFFFF
    actual = struct.unpack_from("<H", payload, len(payload) - 2)[0]

    return calculated == actual
