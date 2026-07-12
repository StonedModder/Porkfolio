package org.bdj;

import java.io.*;
import java.net.*;
import java.lang.*;
import java.lang.reflect.*;

import java.awt.BorderLayout;
import javax.tv.xlet.Xlet;
import javax.tv.xlet.XletContext;
import org.havi.ui.HScene;
import org.havi.ui.HSceneFactory;

import org.bdj.sandbox.Exploit;
import org.bdj.sandbox.ExploitInternal;
import org.bdj.api.NativeInvoke;

public class InitXlet implements Xlet {
    private HScene scene;
    private Screen screen;
    private InternalJarLoader internalJarLoader;
    private Thread internalJarLoaderThread;
    private final String jarLoaderThreadName = "JarLoader";

    public void initXlet(XletContext context) {
        Status.setScreenOutputEnabled(true);
        Status.println("BD-J init");

        screen = Screen.getInstance();
        screen.setSize(1920, 1080);
        screen.setTitle("BDJB Autoloader");
        screen.setProgress(0, "BOOTING...");

        scene = HSceneFactory.getInstance().getDefaultHScene();
        scene.add(screen, BorderLayout.CENTER);
        scene.validate();
    }

    public void startXlet() {
        screen.setVisible(true);
        scene.setVisible(true);

        Status.info("Screen initialized");

        try {
            Status.info("Triggering sandbox escape exploit...");

            if (!Exploit.disableSecurityManager()) {
                ExploitInternal.disableSecurityManager();
            }
        } catch (Exception e) {
            Status.printStackTrace("Error when disabling sandbox: ", e);
        }

        // Add sanity check
        if (System.getSecurityManager() == null) {
            Status.success("Exploit success - sandbox escape achieved");
            screen.startAnimations();
            Status.info("Starting Poopsloit in 3 seconds...");
            try { Thread.sleep(3000); } catch (Exception e) {}

            try {
                internalJarLoader = new InternalJarLoader();
                internalJarLoaderThread = new Thread(internalJarLoader, jarLoaderThreadName);
                internalJarLoaderThread.start();
            } catch (Throwable e) {
                Status.printStackTrace("Loader startup failed", e);
            }
        } else {
            Status.error("Exploit failed - sandbox still active");
        }

    }

    public void pauseXlet() {
        screen.setVisible(false);
    }

    public void destroyXlet(boolean unconditional) {
        scene.remove(screen);
        scene = null;
    }

    private void disableFileProxies() {
        try {
            Class bdjFactoryClass = Class.forName("com.oracle.orbis.io.BDJFactory");

            Field instanceField = bdjFactoryClass.getDeclaredField("instance");
            instanceField.setAccessible(true);

            Object currentInstance = instanceField.get(null);
            Status.println("Current BDJFactory instance: " +
                (currentInstance != null ? currentInstance.getClass().getName() : "null"));

            // Null out the instance - this will make needProxy() return false
            instanceField.set(null, null);
            Status.println("BDJFactory instance set to null");

            Object newInstance = instanceField.get(null);
            Status.println("New BDJFactory instance: " +
                (newInstance != null ? newInstance.getClass().getName() : "null"));

            Status.println("Setting java.io.tmpdir to /download0/BD_BUDA/javatmp");
            System.setProperty("java.io.tmpdir", "/download0/BD_BUDA/javatmp");

        } catch (Exception e) {
            Status.printStackTrace("Error disabling BDJFactory", e);
        }
    }

}
