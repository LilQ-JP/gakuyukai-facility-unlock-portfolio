function compareText(left, right) {
  return String(left || "").localeCompare(String(right || ""), "ja", {
    numeric: true,
    sensitivity: "base"
  });
}

function textValue(device, sortBy) {
  if (sortBy === "facility") return device.roomNames?.join("・") || "";
  if (sortBy === "type") return device.deviceType || "";
  return device.deviceName || "";
}

export function sortSwitchBotDevices(devices, sortBy = "battery", direction = "asc") {
  const factor = direction === "desc" ? -1 : 1;
  return [...(devices || [])].sort((left, right) => {
    if (sortBy === "battery") {
      const leftAvailable = Number.isFinite(left.battery);
      const rightAvailable = Number.isFinite(right.battery);
      // 取得できない機器は、昇順・降順のどちらでも最後にまとめます。
      if (leftAvailable !== rightAvailable) return leftAvailable ? -1 : 1;
      if (leftAvailable && left.battery !== right.battery) return (left.battery - right.battery) * factor;
    } else {
      const compared = compareText(textValue(left, sortBy), textValue(right, sortBy));
      if (compared) return compared * factor;
    }

    const byName = compareText(left.deviceName, right.deviceName);
    if (byName) return byName * factor;
    return compareText(left.deviceId, right.deviceId) * factor;
  });
}

export function nextSortDirection(direction) {
  return direction === "asc" ? "desc" : "asc";
}

export function switchBotOrderLabel(sortBy, direction) {
  const ascending = direction === "asc";
  if (sortBy === "battery") return ascending ? "少ない順" : "多い順";
  return ascending ? "昇順" : "降順";
}
