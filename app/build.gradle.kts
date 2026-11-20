plugins {
    id("com.android.application")
}

val storeRelease = providers.gradleProperty("storeRelease").orNull == "true"

android {
    namespace = "com.ritm.driverplanner"
    compileSdk = if (storeRelease) 36 else 35

    defaultConfig {
        applicationId = "com.ritm.driverplanner"
        minSdk = 23
        targetSdk = if (storeRelease) 36 else 34
        versionCode = 4
        versionName = "1.0.3"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
}
