// Put an audio track under a finished video without re-encoding either: swift mux.swift <video.mp4> <audio.m4a> <out.mp4>
import AVFoundation

let a = CommandLine.arguments
let video = AVURLAsset(url: URL(fileURLWithPath: a[1]))
let audio = AVURLAsset(url: URL(fileURLWithPath: a[2]))
let comp = AVMutableComposition()
let vt = video.tracks(withMediaType: .video)[0]
let cv = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!
try! cv.insertTimeRange(CMTimeRange(start: .zero, duration: video.duration), of: vt, at: .zero)
cv.preferredTransform = vt.preferredTransform
let at = audio.tracks(withMediaType: .audio)[0]
let ca = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
try! ca.insertTimeRange(CMTimeRange(start: .zero, duration: CMTimeMinimum(video.duration, audio.duration)), of: at, at: .zero)
let out = URL(fileURLWithPath: a[3])
try? FileManager.default.removeItem(at: out)
let ex = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetPassthrough)!
ex.outputURL = out
ex.outputFileType = .mp4
let done = DispatchSemaphore(value: 0)
ex.exportAsynchronously { done.signal() }
done.wait()
print(ex.status == .completed ? "wrote \(a[3])" : "failed: \(String(describing: ex.error))")
