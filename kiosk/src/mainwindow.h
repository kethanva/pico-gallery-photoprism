#ifndef MAINWINDOW_H
#define MAINWINDOW_H

#include <QMainWindow>
#include <QWebEngineView>
#include <QTimer>
#include <QNetworkAccessManager>
#include "configmanager.h"

class MainWindow : public QMainWindow
{
    Q_OBJECT
public:
    explicit MainWindow(ConfigManager &config, QWidget *parent = nullptr);
    ~MainWindow();

private slots:
    void handleLoadFinished(bool ok);
    void checkConnection();

private:
    QWebEngineView *m_view;
    ConfigManager &m_config;
    QTimer *m_reconnectTimer;
    QNetworkAccessManager *m_nam;
    bool m_isErrorState = false;
    QString m_indexUrl;

    void showErrorPage();
    void loadApp();
};

#endif // MAINWINDOW_H
