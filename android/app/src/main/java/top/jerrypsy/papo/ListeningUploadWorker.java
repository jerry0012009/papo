package top.jerrypsy.papo;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

public class ListeningUploadWorker extends Worker {
    public ListeningUploadWorker(@NonNull Context context, @NonNull WorkerParameters parameters) {
        super(context, parameters);
    }

    @NonNull
    @Override
    public Result doWork() {
        boolean uploaded = ListeningBatchUploader.uploadAll(getApplicationContext());
        if (uploaded || !ListeningBatchUploader.hasPending(getApplicationContext())) return Result.success();
        return Result.retry();
    }
}
