package top.jerrypsy.papo;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.ImageFormat;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Size;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.util.Collections;

final class CameraFrameCapture {
    interface FrameCallback {
        void complete(File imageFile, String error);
    }

    interface StateCallback {
        void ready();
        void failed(String error);
    }

    private final Context context;
    private final HandlerThread cameraThread = new HandlerThread("PapoCamera");
    private Handler handler;
    private CameraDevice camera;
    private CameraCaptureSession session;
    private ImageReader imageReader;
    private String cameraId;
    private int sensorOrientation;
    private Size captureSize = new Size(640, 480);
    private File pendingFile;
    private FrameCallback pendingCallback;
    private Runnable pendingTimeout;

    CameraFrameCapture(Context context) {
        this.context = context.getApplicationContext();
    }

    @SuppressLint("MissingPermission")
    void start(String facing, StateCallback stateCallback) throws CameraAccessException {
        cameraThread.start();
        handler = new Handler(cameraThread.getLooper());
        CameraManager manager = (CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
        int targetFacing = "back".equals(facing)
            ? CameraCharacteristics.LENS_FACING_BACK
            : CameraCharacteristics.LENS_FACING_FRONT;
        for (String id : manager.getCameraIdList()) {
            CameraCharacteristics characteristics = manager.getCameraCharacteristics(id);
            Integer availableFacing = characteristics.get(CameraCharacteristics.LENS_FACING);
            if (availableFacing != null && availableFacing == targetFacing) {
                cameraId = id;
                Integer orientation = characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION);
                sensorOrientation = orientation == null ? 0 : orientation;
                StreamConfigurationMap configuration = characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
                if (configuration != null) captureSize = chooseCaptureSize(configuration.getOutputSizes(ImageFormat.JPEG));
                break;
            }
        }
        if (cameraId == null) throw new CameraAccessException(CameraAccessException.CAMERA_ERROR, "Requested camera is unavailable");

        imageReader = ImageReader.newInstance(captureSize.getWidth(), captureSize.getHeight(), ImageFormat.JPEG, 2);
        imageReader.setOnImageAvailableListener(this::handleImage, handler);
        manager.openCamera(cameraId, new CameraDevice.StateCallback() {
            @Override
            public void onOpened(CameraDevice opened) {
                camera = opened;
                createSession(stateCallback);
            }

            @Override
            public void onDisconnected(CameraDevice disconnected) {
                disconnected.close();
                camera = null;
                failPending("camera-disconnected");
                stateCallback.failed("camera-disconnected");
            }

            @Override
            public void onError(CameraDevice failed, int error) {
                failed.close();
                camera = null;
                failPending("camera-error-" + error);
                stateCallback.failed("camera-error-" + error);
            }
        }, handler);
    }

    void capture(File output, FrameCallback callback) {
        if (handler == null) {
            callback.complete(null, "camera-not-started");
            return;
        }
        handler.post(() -> {
            if (camera == null || session == null || imageReader == null || pendingCallback != null) {
                callback.complete(null, "camera-not-ready");
                return;
            }
            try {
                pendingFile = output;
                pendingCallback = callback;
                CaptureRequest.Builder request = camera.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
                request.addTarget(imageReader.getSurface());
                request.set(CaptureRequest.JPEG_ORIENTATION, sensorOrientation);
                pendingTimeout = () -> failPending("camera-timeout");
                handler.postDelayed(pendingTimeout, 5_000);
                session.capture(request.build(), new CameraCaptureSession.CaptureCallback() {
                    @Override
                    public void onCaptureFailed(CameraCaptureSession captureSession, CaptureRequest captureRequest, android.hardware.camera2.CaptureFailure failure) {
                        failPending("camera-capture-failed");
                    }
                }, handler);
            } catch (Exception error) {
                failPending(error.getClass().getSimpleName());
            }
        });
    }

    void close() {
        if (handler != null) {
            handler.post(() -> {
                failPending("camera-closed");
                if (session != null) session.close();
                if (camera != null) camera.close();
                if (imageReader != null) imageReader.close();
                session = null;
                camera = null;
                imageReader = null;
            });
        }
        cameraThread.quitSafely();
    }

    private void createSession(StateCallback stateCallback) {
        if (camera == null || imageReader == null) return;
        try {
            camera.createCaptureSession(Collections.singletonList(imageReader.getSurface()), new CameraCaptureSession.StateCallback() {
                @Override
                public void onConfigured(CameraCaptureSession configured) {
                    session = configured;
                    stateCallback.ready();
                }

                @Override
                public void onConfigureFailed(CameraCaptureSession failed) {
                    failPending("camera-session-failed");
                    stateCallback.failed("camera-session-failed");
                }
            }, handler);
        } catch (CameraAccessException error) {
            failPending("camera-session-error");
            stateCallback.failed("camera-session-error");
        }
    }

    private void handleImage(ImageReader reader) {
        Image image = reader.acquireLatestImage();
        if (image == null) return;
        File output = pendingFile;
        FrameCallback callback = pendingCallback;
        try {
            if (output == null || callback == null) return;
            ByteBuffer buffer = image.getPlanes()[0].getBuffer();
            byte[] bytes = new byte[buffer.remaining()];
            buffer.get(bytes);
            try (FileOutputStream stream = new FileOutputStream(output)) {
                stream.write(bytes);
                stream.getFD().sync();
            }
            clearPending();
            callback.complete(output, null);
        } catch (Exception error) {
            failPending(error.getClass().getSimpleName());
        } finally {
            image.close();
        }
    }

    private void failPending(String error) {
        FrameCallback callback = pendingCallback;
        File output = pendingFile;
        clearPending();
        if (output != null) output.delete();
        if (callback != null) callback.complete(null, error);
    }

    private void clearPending() {
        if (handler != null && pendingTimeout != null) handler.removeCallbacks(pendingTimeout);
        pendingTimeout = null;
        pendingCallback = null;
        pendingFile = null;
    }

    private static Size chooseCaptureSize(Size[] sizes) {
        if (sizes == null || sizes.length == 0) return new Size(640, 480);
        Size chosen = sizes[0];
        long targetPixels = 640L * 480L;
        long bestDistance = Math.abs((long) chosen.getWidth() * chosen.getHeight() - targetPixels);
        for (Size size : sizes) {
            long pixels = (long) size.getWidth() * size.getHeight();
            long distance = Math.abs(pixels - targetPixels);
            if (distance < bestDistance) {
                chosen = size;
                bestDistance = distance;
            }
        }
        return chosen;
    }
}
