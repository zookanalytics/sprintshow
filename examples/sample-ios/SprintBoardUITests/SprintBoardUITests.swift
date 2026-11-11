// Drives the sample board through its steps and attaches a screenshot at each one.
// `sprintshow simulator` runs this test once in light and once in dark, and saves each
// screenshot under the name it is attached with, such as 01-board.light.png.

import XCTest

final class SprintBoardUITests: XCTestCase {
    func testBoard() {
        let app = XCUIApplication()
        app.launch()

        let summary = app.staticTexts["summary"]
        XCTAssertTrue(summary.waitForExistence(timeout: 20), "the board never showed its summary")
        XCTAssertEqual(summary.label, "3 tasks · 1 done")
        snapshot("01-board")

        app.buttons["task-0"].tap()
        let twoDone = expectation(for: NSPredicate(format: "label == %@", "3 tasks · 2 done"), evaluatedWith: summary)
        wait(for: [twoDone], timeout: 10)
        snapshot("02-first-task-done")
    }

    /// Attach a screenshot of the whole screen under `name`, kept whether the test passes or fails.
    private func snapshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
