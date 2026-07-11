package top.jerrypsy.papo;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PapoListeningPlugin.class);
        registerPlugin(PapoUpdaterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
