#include "mainwindow.h"
#include <QFile>
#include <QDir>
#include <QCoreApplication>
#include <QWebEnginePage>
#include <QWebEngineProfile>
#include <QWebEngineSettings>
#include <QWebEngineCertificateError>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QDebug>

MainWindow::MainWindow(ConfigManager &config, QWidget *parent)
    : QMainWindow(parent), m_config(config)
{
    // Configure WebEngine settings for Kiosk and CORS bypass
    QWebEngineProfile *profile = QWebEngineProfile::defaultProfile();
    QWebEngineSettings *settings = profile->settings();
    
    // Crucial: Allow local content (file://) to load resources from remote HTTP APIs
    settings->setAttribute(QWebEngineSettings::LocalContentCanAccessRemoteUrls, true);
    settings->setAttribute(QWebEngineSettings::LocalContentCanAccessFileUrls, true);
    settings->setAttribute(QWebEngineSettings::LocalStorageEnabled, true);
    settings->setAttribute(QWebEngineSettings::JavascriptEnabled, true);
    settings->setAttribute(QWebEngineSettings::ScrollAnimatorEnabled, true);

    m_view = new QWebEngineView(this);
    QWebEnginePage *page = m_view->page();
    
    if (m_config.ignoreCertificateErrors()) {
        connect(page, &QWebEnginePage::certificateError, this, [](QWebEngineCertificateError error) {
            qWarning() << "SSL Certificate Error ignored (type:" << static_cast<int>(error.type()) << ")";
            error.acceptCertificate();
        });
    }
    
    setCentralWidget(m_view);

    // Resolve index.html path
    QString appDir = QCoreApplication::applicationDirPath();
    QStringList paths = {
        appDir + "/frontend/dist/index.html",
        appDir + "/../frontend/dist/index.html",
        QDir::currentPath() + "/frontend/dist/index.html",
        QDir::currentPath() + "/dist/index.html"
    };

    bool found = false;
    for (const QString &path : paths) {
        if (QFile::exists(path)) {
            m_indexUrl = "file://" + QDir(path).absolutePath();
            found = true;
            break;
        }
    }

    if (!found) {
        qFatal("Could not locate frontend/dist/index.html in any of the standard directories.");
    }

    // Set Window properties
    setWindowTitle(m_config.windowTitle());
    if (m_config.fullscreen()) {
        setWindowFlags(Qt::Window | Qt::FramelessWindowHint);
        showFullScreen();
    } else {
        resize(1200, 800);
    }

    // Reconnect Monitor
    m_nam = new QNetworkAccessManager(this);
    m_reconnectTimer = new QTimer(this);
    m_reconnectTimer->setInterval(5000); // Check connection every 5s if failed
    connect(m_reconnectTimer, &QTimer::timeout, this, &MainWindow::checkConnection);

    connect(m_view, &QWebEngineView::loadFinished, this, &MainWindow::handleLoadFinished);

    loadApp();
}

MainWindow::~MainWindow()
{
}

void MainWindow::loadApp()
{
    m_isErrorState = false;
    m_reconnectTimer->stop();
    m_view->load(QUrl(m_indexUrl));
}

void MainWindow::handleLoadFinished(bool ok)
{
    if (!ok && !m_isErrorState) {
        qWarning() << "Failed to load page. Entering offline/recovery state.";
        showErrorPage();
    }
}

void MainWindow::showErrorPage()
{
    m_isErrorState = true;
    
    // Premium dark-mode offline page
    QString errorHtml = R"(
    <!DOCTYPE html>
    <html>
    <head>
      <title>Connection Restoring</title>
      <style>
        body {
          background-color: #0b0f19;
          color: #cbd5e1;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100vh;
          margin: 0;
          overflow: hidden;
        }
        .spinner {
          width: 48px;
          height: 48px;
          border: 4px solid rgba(255, 255, 255, 0.08);
          border-left-color: #3182ce;
          border-radius: 50%;
          animation: spin 1s linear infinite;
          margin-bottom: 24px;
        }
        h1 {
          font-size: 20px;
          font-weight: 500;
          margin-bottom: 8px;
          color: #f8fafc;
        }
        p {
          font-size: 14px;
          color: #64748b;
          margin: 0;
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      </style>
    </head>
    <body>
      <div class="spinner"></div>
      <h1>Waiting for PhotoPrism...</h1>
      <p>The backend server is currently unreachable. Reconnecting automatically.</p>
    </body>
    </html>
    )";
    
    m_view->setHtml(errorHtml);
    m_reconnectTimer->start();
}

void MainWindow::checkConnection()
{
    // Try pinging the PhotoPrism backend directly to see if it responds
    QUrl backendUrl(m_config.serverUrl() + "/api/v1/ready");
    QNetworkRequest request(backendUrl);
    
    QNetworkReply *reply = m_nam->get(request);
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        if (reply->error() == QNetworkReply::NoError) {
            qInfo() << "PhotoPrism backend is reachable. Reloading application.";
            loadApp();
        } else {
            qDebug() << "PhotoPrism backend still unreachable:" << reply->errorString();
        }
        reply->deleteLater();
    });
}
