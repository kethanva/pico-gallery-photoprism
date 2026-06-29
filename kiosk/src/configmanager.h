#ifndef CONFIGMANAGER_H
#define CONFIGMANAGER_H

#include <QString>
#include <QObject>

class ConfigManager : public QObject
{
    Q_OBJECT
public:
    explicit ConfigManager(QObject *parent = nullptr);
    bool loadConfig(const QString &filePath = "");

    QString serverUrl() const;
    bool fullscreen() const;
    bool ignoreCertificateErrors() const;
    QString startupPage() const;
    QString windowTitle() const;

private:
    QString m_serverUrl = "http://localhost:2342";
    bool m_fullscreen = false;
    bool m_ignoreCertificateErrors = true;
    QString m_startupPage = "/library";
    QString m_windowTitle = "Photo Frame";
};

#endif // CONFIGMANAGER_H
