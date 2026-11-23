package com.boomai.daytraderdesk;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ScanKeeperPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
