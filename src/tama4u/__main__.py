import logging
import threading
import time
from typing import TYPE_CHECKING, Annotated, Any, ParamSpec

import typer
from ndef import Record, message_encoder
from nfc import ContactlessFrontend
from nfc.snep import SnepClient, SnepServer, Success
from rich.logging import RichHandler

from tama4u.protocol import create_download_message, create_handshake_message, parse_response

if TYPE_CHECKING:
    from collections.abc import Callable

    from nfc.llcp.llc import LogicalLinkController

app = typer.Typer()
clf: ContactlessFrontend | None = None
server: DefaultSnepServer | None = None

P = ParamSpec("P")

FORMAT = "%(message)s"
logging.basicConfig(level="DEBUG", format=FORMAT, datefmt="[%X]", handlers=[RichHandler()])

# logging.getLogger("nfc.llcp").setLevel(logging.DEBUG)
# logging.getLogger("nfc.snep").setLevel(logging.DEBUG)

logger = logging.getLogger()


def on_llcp_startup(llc: LogicalLinkController) -> LogicalLinkController:
    global server  # noqa: PLW0603
    server = DefaultSnepServer(llc)
    return llc


llcp_options = {
    "on-startup": on_llcp_startup,
    "miu": 2175,
    "lto": 1500,
    "role": "target",
    "agf": False,
}


class DefaultSnepServer(SnepServer):
    def __init__(self, llc: LogicalLinkController) -> None:
        super().__init__(llc)
        self.response = None

    def process_put_request(self, ndef_message: list[Record]) -> int:
        logger.info("client has put an NDEF message")
        self.response = ndef_message
        return Success


def dispatch[**P](func: Callable[P, Any]) -> Callable[P, bool]:
    def connected(*args: P.args) -> bool:
        logger.debug("starting thread")
        threading.Thread(target=func, args=args).start()
        return True

    return connected


def send_message(message: list[Record]) -> Callable[[LogicalLinkController], None]:
    def _send_message(llc: LogicalLinkController) -> None:
        logger.info("sending message %s", message)
        t0 = time.time()

        snep = SnepClient(llc)
        snep.connect(4)

        if not snep.put_records(message):
            logger.error("failed to send message")
        if t0 is not None:
            transfer_time = time.time() - t0
            message_size = len(b"".join(message_encoder(message)))
            logger.info(
                "message sent in %.3f seconds (%d byte @ %.0f byte/sec)",
                transfer_time,
                message_size,
                message_size / transfer_time,
            )

    return _send_message


def start_server(llc: LogicalLinkController) -> bool:
    server.start()
    return True


@app.callback()
def main() -> None:
    global clf  # noqa: PLW0603
    clf = ContactlessFrontend("usb")


@app.command()
def handshake() -> None:
    message = [create_handshake_message()]
    logger.info(message)

    clf.connect(llcp=llcp_options | {"on-connect": dispatch(send_message(message))})
    clf.connect(llcp=llcp_options | {"on-connect": start_server})

    logger.info(parse_response(server.response))


@app.command()
def send(file: Annotated[typer.FileBinaryRead, typer.Argument()]) -> None:
    handshake()

    message = [create_download_message(file.read())]
    clf.connect(llcp=llcp_options | {"on-connect": dispatch(send_message(message))})
    clf.connect(llcp=llcp_options | {"on-connect": start_server})

    logger.info(server.response)


if __name__ == "__main__":
    app()
