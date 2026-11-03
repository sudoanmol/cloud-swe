#if DEBUG
import os
import UIKit

/// Debug builds only: logs every frame that took 50 ms or more (three dropped at 60 Hz), so jank shows up in the log
/// next to what the app was doing. Read it with `log stream --predicate 'subsystem == "com.anmolhurkat.CloudSWE"'`.
final class FrameWatch: NSObject {
    nonisolated private static let log = Logger(subsystem: "com.anmolhurkat.CloudSWE", category: "frames")
    private static let shared = FrameWatch()
    private var last: CFTimeInterval = 0

    /// Something the app did, to line up with the hitches. Also kept in Caches/debug.log, which can be copied off the
    /// phone: `xcrun devicectl device copy from --device <udid> --domain-type appDataContainer
    /// --domain-identifier com.anmolhurkat.CloudSWE --source Library/Caches/debug.log --destination <file>`.
    nonisolated static func note(_ what: String) {
        log.notice("\(what, privacy: .public)")
        let line = Data("\(Date.now.formatted(.iso8601.time(includingFractionalSeconds: true))) \(what)\n".utf8)
        guard let file = try? FileHandle(forWritingTo: file) else {
            try? line.write(to: Self.file)
            return
        }
        file.seekToEndOfFile()
        file.write(line)
        try? file.close()
    }

    nonisolated private static let file = URL.cachesDirectory.appending(path: "debug.log")

    static func start() {
        CADisplayLink(target: shared, selector: #selector(tick)).add(to: .main, forMode: .common)
    }

    @objc private func tick(_ link: CADisplayLink) {
        let gap = link.timestamp - last
        if last > 0, gap >= 0.05 { Self.note("hitch \(Int(gap * 1000)) ms") }
        last = link.timestamp
    }
}
#endif
