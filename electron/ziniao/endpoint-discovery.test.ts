import assert from "node:assert/strict";
import test from "node:test";

import { selectStoreProcess, type ZiniaoProcess } from "./endpoint-discovery";

function candidate(processId: number, storeId: string, suffix = ""): ZiniaoProcess {
  return {
    Name: "ziniaobrowser.exe",
    ProcessId: processId,
    ExecutablePath: "C:\\Ziniao\\ziniaobrowser.exe",
    CommandLine: `"C:\\Ziniao\\ziniaobrowser.exe" --store_data_path=x --user-data-dir="C:\\Profiles\\chrome_${storeId}${suffix}"`,
  };
}

test("endpoint discovery selects only the exact non-renderer store process", () => {
  const processes = [
    candidate(10, "store-1"),
    candidate(11, "store-10"),
    {
      ...candidate(12, "store-1"),
      CommandLine:
        '"C:\\Ziniao\\ziniaobrowser.exe" --type=renderer --store_data_path=x --user-data-dir="C:\\Profiles\\chrome_store-1"',
    },
  ];
  assert.equal(selectStoreProcess(processes, "store-1").ProcessId, 10);
  assert.throws(
    () => selectStoreProcess([...processes, candidate(13, "store-1")], "store-1"),
    /not uniquely identifiable/i,
  );
  assert.throws(
    () => selectStoreProcess(processes, "missing"),
    /not uniquely identifiable/i,
  );
});
