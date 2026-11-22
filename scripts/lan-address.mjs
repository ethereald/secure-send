import { createSocket } from "node:dgram";

const socket = createSocket("udp4");
socket.on("error", (error) => {
  console.error(`Could not determine the LAN address: ${error.message}`);
  socket.close();
  process.exitCode = 1;
});
socket.connect(9, "192.0.2.1", () => {
  console.log(socket.address().address);
  socket.close();
});
