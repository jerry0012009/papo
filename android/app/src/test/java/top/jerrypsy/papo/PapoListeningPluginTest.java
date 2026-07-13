package top.jerrypsy.papo;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class PapoListeningPluginTest {
    @Test
    public void readsJavaScriptIntegerDurationsWithoutFallingBack() {
        assertEquals(900_000L, PapoListeningPlugin.requestedDurationMs(Integer.valueOf(900_000)));
        assertEquals(3_600_000L, PapoListeningPlugin.requestedDurationMs(Long.valueOf(3_600_000L)));
    }

    @Test
    public void defaultsOnlyWhenDurationIsMissing() {
        assertEquals(180_000L, PapoListeningPlugin.requestedDurationMs((Object) null));
    }

    @Test
    public void nativeCaptureCadenceProtectsTheAudioProvider() {
        assertEquals(120_000L, PapoListeningService.SLICE_MS);
        assertEquals(300_000L, PapoListeningService.CAMERA_INTERVAL_MS);
    }

    @Test
    public void manualPhotoResetsTheFiveMinuteCameraCadence() {
        long capturedAt = 1_000_000L;
        assertEquals(300_000L, PapoListeningService.nextCameraCaptureDelay(capturedAt, capturedAt, capturedAt + 900_000L));
        assertEquals(-1L, PapoListeningService.nextCameraCaptureDelay(capturedAt, capturedAt, capturedAt + 299_999L));
        assertEquals(0L, PapoListeningService.nextCameraCaptureDelay(capturedAt, 0, capturedAt + 900_000L));
        assertEquals("front", PapoListeningService.captureFacingForAction(PapoListeningService.ACTION_CAPTURE_FRONT));
        assertEquals("back", PapoListeningService.captureFacingForAction(PapoListeningService.ACTION_CAPTURE_BACK));
        assertEquals(null, PapoListeningService.captureFacingForAction(PapoListeningService.ACTION_STOP));
        assertEquals("scheduled", PapoListeningService.CAPTURE_INTENT_SCHEDULED);
        assertEquals("user_initiated", PapoListeningService.CAPTURE_INTENT_USER_INITIATED);
    }
}
