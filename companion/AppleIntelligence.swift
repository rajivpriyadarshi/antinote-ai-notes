import Foundation
import FoundationModels

struct Request: Decodable {
    let content: String
    let instructions: String
}

struct Response: Encodable {
    let ok: Bool
    let output: String?
    let error: String?
}

func write(_ response: Response) {
    let encoder = JSONEncoder()
    guard let data = try? encoder.encode(response) else { return }
    FileHandle.standardOutput.write(data)
}

@available(macOS 26.0, *)
func process(_ request: Request) async {
    let model = SystemLanguageModel.default
    guard case .available = model.availability else {
        let message: String
        switch model.availability {
        case .unavailable(.appleIntelligenceNotEnabled):
            message = "Apple Intelligence is turned off. Enable it in System Settings, then try again."
        case .unavailable(.deviceNotEligible):
            message = "This Mac does not support Apple Intelligence. Choose an API provider in ::ai_setup()."
        case .unavailable(.modelNotReady):
            message = "Apple Intelligence is still preparing on this Mac. Try again shortly."
        default:
            message = "Apple Intelligence is unavailable on this Mac. Choose an API provider in ::ai_setup()."
        }
        write(Response(ok: false, output: nil, error: message))
        return
    }

    do {
        let session = LanguageModelSession(model: model, instructions: request.instructions)
        let response = try await session.respond(to: request.content)
        let output = response.content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !output.isEmpty else {
            write(Response(ok: false, output: nil, error: "Apple Intelligence returned no text."))
            return
        }
        write(Response(ok: true, output: output, error: nil))
    } catch {
        write(Response(ok: false, output: nil, error: "Apple Intelligence could not process this note. \(error.localizedDescription)"))
    }
}

@main
struct AppleIntelligenceBridge {
    static func main() async {
        guard #available(macOS 26.0, *) else {
            write(Response(ok: false, output: nil, error: "Apple Intelligence requires macOS 26 or later. Choose an API provider in ::ai_setup()."))
            return
        }
        do {
            let data = try FileHandle.standardInput.readToEnd() ?? Data()
            let request = try JSONDecoder().decode(Request.self, from: data)
            await process(request)
        } catch {
            write(Response(ok: false, output: nil, error: "Apple Intelligence received an invalid request."))
        }
    }
}
