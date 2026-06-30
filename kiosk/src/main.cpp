#include <QApplication>
#include "mainwindow.h"
#include "configmanager.h"
#include <QDebug>

int main(int argc, char *argv[])
{
    // Pass chromium flags to disable web security (CORS bypass) and sandbox
    qputenv("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-web-security --ignore-certificate-errors");
    qputenv("QTWEBENGINE_DISABLE_SANDBOX", "1");

    QApplication app(argc, argv);

    // Initialize Config
    ConfigManager config;
    
    // Support passing custom config.json path via command line argument
    QString configPath = "";
    if (argc > 1) {
        configPath = argv[1];
    }
    
    config.loadConfig(configPath);

    // Initialize View
    MainWindow w(config);
    w.show();

    return app.exec();
}
