import { expect, test } from "bun:test";
import { INITIAL_SHARING, sharingBytes, transferBusy, transferFraction } from "../src/sharing";
test("LocalSend progress handles waiting, zero-byte files and receiver acknowledgement", () => {
  const base = INITIAL_SHARING.transfer;
  expect(transferBusy({ ...base, state: "waiting" })).toBe(true);
  expect(transferBusy({ ...base, state: "cancelled" })).toBe(false);
  expect(transferFraction({ ...base, filesDone: 1, filesTotal: 2 })).toBe(0.5);
  expect(transferFraction({ ...base, bytesDone: 300, bytesTotal: 1000 })).toBe(0.3);
  expect(transferFraction({ ...base, bytesDone: 2000, bytesTotal: 1000 })).toBe(1);
  expect(transferFraction({ ...base, state: "succeeded" })).toBe(1);
  expect(transferFraction(base)).toBe(0);
});
test("LocalSend file sizes include gigabyte transfers and unknown input", () => {
  expect(sharingBytes(0)).toBe("0 B");
  expect(sharingBytes(1024)).toBe("1.0 KB");
  expect(sharingBytes(1024 ** 3)).toBe("1.0 GB");
  expect(sharingBytes(NaN)).toBe("0 B");
});
