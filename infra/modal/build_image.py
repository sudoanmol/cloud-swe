# /// script
# requires-python = ">=3.12"
# dependencies = ["modal==1.5.3"]
# ///
"""Build, verify, and publish the Modal workspace image.

The image is published under MODAL_IMAGE_NAME only after verify.sh passes on a
cold boot and again after a restore from an exit snapshot, which is how the
runner resumes a paused workspace. Uses the active Modal profile or
MODAL_TOKEN_ID/MODAL_TOKEN_SECRET, and MODAL_ENVIRONMENT when set.
"""

import os
import pathlib
import sys

import modal
import modal.experimental

ROOT = pathlib.Path(__file__).parent
APP_NAME = os.environ.get("MODAL_APP_NAME", "cloud-swe-workspaces")
IMAGE_NAME = os.environ.get("MODAL_IMAGE_NAME", "cloud-swe-workspace")
ENTRYPOINT = ("/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf")
SANDBOX_OPTIONS = {"vm_runtime": True, "enable_exit_snapshot": True}


def start(app: modal.App, image: modal.Image) -> modal.Sandbox:
    return modal.Sandbox.create(
        *ENTRYPOINT,
        app=app,
        image=image,
        timeout=20 * 60,
        cpu=2,
        memory=4096,
        experimental_options=SANDBOX_OPTIONS,
    )


def verify(sandbox: modal.Sandbox, phase: str) -> None:
    process = sandbox.exec("bash", "-s")
    process.stdin.write((ROOT / "verify.sh").read_text())
    process.stdin.write_eof()
    process.stdin.drain()
    print(process.stdout.read(), end="")
    print(process.stderr.read(), end="", file=sys.stderr)

    if process.wait() != 0:
        raise SystemExit(f"verify.sh failed after {phase}; the image was not published")

    print(f"verify.sh passed after {phase}")


def main() -> None:
    app = modal.App.lookup(APP_NAME, create_if_missing=True)

    with modal.enable_output():
        image = modal.Image.from_dockerfile(ROOT / "Dockerfile", context_dir=ROOT).build(app)

    cold = start(app, image)

    try:
        verify(cold, "a cold boot")
    finally:
        cold.terminate(wait=True)

    exit_snapshot = cold._experimental_get_exit_snapshot()
    restored = start(app, exit_snapshot)

    try:
        verify(restored, "a restore from an exit snapshot")
    finally:
        restored.terminate(wait=True)
        modal.experimental.image_delete(exit_snapshot.object_id)
        modal.experimental.image_delete(restored._experimental_get_exit_snapshot().object_id)

    image.publish(IMAGE_NAME)
    print(f"published {IMAGE_NAME} ({image.object_id})")


if __name__ == "__main__":
    main()
