"""Pull a camera frame from the bird-cam over the ESPHome native API.

The YOLO inference load makes the device slow to answer; this script retries
the connection, pauses detection via the "Detection Enabled" switch, grabs a
frame, then re-enables detection.

Usage: python snapshot.py <host> <noise_psk> <outfile.png> [--keep-paused]
"""
import asyncio
import inspect
import sys

from aioesphomeapi import APIClient, CameraState, SwitchInfo


async def maybe_await(result):
    if inspect.isawaitable(result):
        return await result
    return result


async def connect_with_retry(cli: APIClient, attempts: int = 8) -> None:
    for i in range(1, attempts + 1):
        try:
            await cli.connect(login=True)
            return
        except Exception as err:  # noqa: BLE001
            print(f"connect attempt {i}/{attempts} failed: {err}")
            await asyncio.sleep(4)
    raise SystemExit("could not connect to device API")


async def main() -> int:
    host, psk, outfile = sys.argv[1], sys.argv[2], sys.argv[3]
    keep_paused = "--keep-paused" in sys.argv
    cli = APIClient(host, 6053, None, noise_psk=psk)
    await connect_with_retry(cli)
    info = await cli.device_info()
    print(f"connected: {info.name} (esphome {info.esphome_version})")

    entities, _services = await cli.list_entities_services()
    detection_switch = next(
        (e for e in entities if isinstance(e, SwitchInfo) and "Detection" in e.name),
        None,
    )
    if detection_switch:
        print("pausing detection...")
        await maybe_await(cli.switch_command(detection_switch.key, False))
        await asyncio.sleep(3)

    fut: asyncio.Future[bytes] = asyncio.get_event_loop().create_future()

    def on_state(state) -> None:
        if isinstance(state, CameraState) and state.data and not fut.done():
            fut.set_result(bytes(state.data))

    cli.subscribe_states(on_state)
    await maybe_await(cli.request_single_image())
    await maybe_await(cli.request_image_stream())
    data = await asyncio.wait_for(fut, timeout=60)
    print(f"received {len(data)} bytes")

    if data[:2] == b"\xff\xd8":
        with open(outfile, "wb") as f:
            f.write(data)
        print(f"saved JPEG -> {outfile}")
    elif len(data) == 320 * 240 * 2:
        from PIL import Image

        with open(outfile + ".raw", "wb") as f:
            f.write(data)
        # camera outputs RGB565 big-endian; PIL raw modes expect little-endian
        swapped = bytearray(len(data))
        swapped[0::2] = data[1::2]
        swapped[1::2] = data[0::2]
        img = Image.frombytes("RGB", (320, 240), bytes(swapped), "raw", "BGR;16")
        img.save(outfile)
        print(f"converted RGB565 -> {outfile} (raw kept at {outfile}.raw)")
    else:
        raw = outfile + ".raw"
        with open(raw, "wb") as f:
            f.write(data)
        print(f"unknown format ({len(data)} bytes), saved raw -> {raw}")

    if detection_switch and not keep_paused:
        print("re-enabling detection...")
        await maybe_await(cli.switch_command(detection_switch.key, True))
    await cli.disconnect()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
