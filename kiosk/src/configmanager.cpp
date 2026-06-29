#include "configmanager.h"
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QDebug>
#include <QCoreApplication>
#include <QDir>

ConfigManager::ConfigManager(QObject *parent) : QObject(parent)
{
}

bool ConfigManager::loadConfig(const QString &filePath)
{
    QString targetPath = filePath;
    if (targetPath.isEmpty()) {
        // Look in executable directory, then current directory
        QString appDirFile = QCoreApplication::applicationDirPath() + "/config.json";
        if (QFile::exists(appDirFile)) {
            targetPath = appDirFile;
        } else if (QFile::exists("config.json")) {
            targetPath = "config.json";
        } else {
            qWarning() << "config.json not found in" << appDirFile << "or current directory. Using default settings.";
            return false;
        }
    }

    QFile file(targetPath);
    if (!file.open(QIODevice::ReadOnly)) {
        qWarning() << "Failed to open config file:" << targetPath;
        return false;
    }

    QByteArray data = file.readAll();
    QJsonDocument doc = QJsonDocument::fromJson(data);
    if (doc.isNull()) {
        qWarning() << "Failed to parse config.json as JSON";
        return false;
    }

    QJsonObject obj = doc.object();
    if (obj.contains("serverUrl")) {
        m_serverUrl = obj.value("serverUrl").toString();
    }
    if (obj.contains("fullscreen")) {
        m_fullscreen = obj.value("fullscreen").toBool();
    }
    if (obj.contains("ignoreCertificateErrors")) {
        m_ignoreCertificateErrors = obj.value("ignoreCertificateErrors").toBool();
    }
    if (obj.contains("startupPage")) {
        m_startupPage = obj.value("startupPage").toString();
    }
    if (obj.contains("windowTitle")) {
        m_windowTitle = obj.value("windowTitle").toString();
    }

    qInfo() << "Loaded config from:" << targetPath;
    qInfo() << "  serverUrl:" << m_serverUrl;
    qInfo() << "  fullscreen:" << m_fullscreen;
    qInfo() << "  ignoreCertificateErrors:" << m_ignoreCertificateErrors;
    qInfo() << "  startupPage:" << m_startupPage;
    qInfo() << "  windowTitle:" << m_windowTitle;

    return true;
}

QString ConfigManager::serverUrl() const { return m_serverUrl; }
bool ConfigManager::fullscreen() const { return m_fullscreen; }
bool ConfigManager::ignoreCertificateErrors() const { return m_ignoreCertificateErrors; }
QString ConfigManager::startupPage() const { return m_startupPage; }
QString ConfigManager::windowTitle() const { return m_windowTitle; }
