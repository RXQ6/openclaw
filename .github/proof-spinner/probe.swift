// Proof-only probe (hosted runner only). Usage: probe <spinners> <nsapp:0|1> <seconds>
// Measures whether orphaned Task.yield spinners and/or a perform-block NSApp.run()
// stop main-actor and global Task.sleep progress under CPU saturation.
import AppKit
import Foundation

let arguments = CommandLine.arguments
let spinnerCount = Int(arguments[1]) ?? 0
let startsApplication = arguments[2] == "1"
let seconds = Int(arguments[3]) ?? 60

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func increment() { self.lock.withLock { self.value += 1 } }
    var current: Int { self.lock.withLock { self.value } }
}

let mainContinuous = Counter()
let globalContinuous = Counter()
let globalUptime = Counter()
let spins = Counter()

// Mirrors TestMLXTransport.nextEvent(): busy-polls with Task.yield() and ignores cancellation.
actor StaleTransport {
    private var events: [Int] = []
    func nextEvent() async -> Int {
        while self.events.isEmpty {
            spins.increment()
            await Task.yield()
        }
        return self.events.removeFirst()
    }
}

let transports = (0..<spinnerCount).map { _ in StaleTransport() }
for transport in transports {
    let reader = Task { await transport.nextEvent() }
    reader.cancel()
}

Task { @MainActor in
    while true {
        try? await Task.sleep(for: .milliseconds(10))
        mainContinuous.increment()
    }
}
Task.detached {
    while true {
        try? await Task.sleep(for: .milliseconds(10))
        globalContinuous.increment()
    }
}
Task.detached {
    while true {
        try? await Task.sleep(nanoseconds: 10_000_000)
        globalUptime.increment()
    }
}

if startsApplication {
    Task { @MainActor in
        let application = NSApplication.shared
        _ = application.setActivationPolicy(.accessory)
        application.finishLaunching()
        RunLoop.main.perform(inModes: [.common]) {
            MainActor.assumeIsolated { application.run() }
        }
    }
}

Thread.detachNewThread {
    var previous = (0, 0, 0, 0)
    var stalledWindows = 0
    for window in 1...(seconds / 5) {
        Thread.sleep(forTimeInterval: 5)
        let now = (mainContinuous.current, globalContinuous.current, globalUptime.current, spins.current)
        let delta = (now.0 - previous.0, now.1 - previous.1, now.2 - previous.2, now.3 - previous.3)
        if delta.0 == 0 { stalledWindows += 1 }
        print("spinners=\(spinnerCount) nsapp=\(startsApplication) t=\(window * 5)s main=\(delta.0) globalCont=\(delta.1) globalUptime=\(delta.2) spins=\(delta.3)")
        previous = now
    }
    print("RESULT spinners=\(spinnerCount) nsapp=\(startsApplication) mainStalledWindows=\(stalledWindows)/\(seconds / 5)")
    exit(0)
}

RunLoop.main.run()
