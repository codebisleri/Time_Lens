import streamlit as st
import pandas as pd
import numpy as np
import plotly.express as px
import plotly.graph_objects as go
from plotly.subplots import make_subplots
from statsmodels.tsa.seasonal import seasonal_decompose
from statsmodels.tsa.stattools import acf, pacf
from statsmodels.tsa.api import Holt, ExponentialSmoothing
from statsmodels.tsa.arima.model import ARIMA
from statsmodels.tsa.statespace.sarimax import SARIMAX
from sklearn.ensemble import IsolationForest
from sklearn.metrics import mean_squared_error, mean_absolute_percentage_error
from sklearn.preprocessing import MinMaxScaler
from sklearn.model_selection import TimeSeriesSplit # Retained in imports, but not used in forecast logic
import warnings
from typing import List, Tuple, Dict, Any
import concurrent.futures
from urllib.parse import quote_plus
import io
import base64
import copy

# =================================================================
# NEW IMPORTS FOR ENHANCEMENTS
# =================================================================
# The 'holidays', 'prophet', 'xgboost', 'plotly' and other libraries are required.
# Install them using:
# pip install holidays prophet xgboost dtaidistance plotly SQLAlchemy pymysql fpdf2 kaleido tensorflow dowhy graphviz pmdarima lightgbm tsfresh
try:
    import holidays
except ImportError:
    holidays = None
try:
    from prophet import Prophet
except ImportError:
    Prophet = None
try:
    import xgboost as xgb
except ImportError:
    xgb = None
try:
    from dtaidistance import dtw
except ImportError:
    dtw = None
try:
    from sqlalchemy import create_engine
except ImportError:
    create_engine = None
try:
    from fpdf import FPDF
except ImportError:
    FPDF = None
try:
    import tensorflow as tf
    from tensorflow.keras.models import Model
    from tensorflow.keras.layers import Layer, Dense, LayerNormalization, MultiHeadAttention, Input, Add
    from tensorflow.keras.optimizers import Adam
except ImportError:
    tf = None # Set tf to None if not installed
try:
    from dowhy import CausalModel
except ImportError:
    CausalModel = None
try:
    import graphviz
except ImportError:
    graphviz = None
# --- NEW IMPORTS ---
try:
    import pmdarima as pm
except ImportError:
    pm = None
try:
    import lightgbm as lgb
except ImportError:
    lgb = None
try:
    from tsfresh import extract_features
    # from tsfresh.utilities.dataframe_functions import roll_time_series
    # from tsfresh.feature_extraction import MinimalFCParameters
    aa=11
except ImportError:
    extract_features = None
# --- END NEW IMPORTS ---


# --- GLOBAL FIX FOR REPRODUCIBILITY ---
if tf:
    # This utility sets the Python, NumPy, and TensorFlow seeds in one go.
    tf.keras.utils.set_random_seed(42)
    # This forces TensorFlow to use deterministic algorithms.
    # It may have a slight performance cost, but it is essential for reproducibility.
    tf.config.experimental.enable_op_determinism()
# --- END FIX ---


# Suppress warnings for a cleaner output
warnings.filterwarnings('ignore')

# =================================================================
# MoE DEEP LEARNING ADDITIONS START
# =================================================================
if tf:
    # Helper function to create sequences for DL models
    def create_sequences(data: np.ndarray, input_len: int, output_len: int) -> Tuple[np.ndarray, np.ndarray]:
        """Creates input sequences and corresponding output sequences for time series forecasting."""
        X, y = [], []
        for i in range(len(data) - input_len - output_len + 1):
            X.append(data[i:(i + input_len), :])  # All features for input
            y.append(data[(i + input_len):(i + input_len + output_len), 0]) # Only target for output
        return np.array(X), np.array(y)

    # Custom Keras Layer for the Seasonality Expert
    class FourierLayer(Layer):
        def __init__(self, period, k, **kwargs):
            super(FourierLayer, self).__init__(**kwargs)
            self.period = period
            self.k = k

        def build(self, input_shape):
            # This layer doesn't have trainable weights, so build is simple
            super(FourierLayer, self).build(input_shape)

        def call(self, inputs):
            # inputs are assumed to be time indices
            time = tf.cast(inputs, tf.float32)
            harmonics = []
            for i in range(1, self.k + 1):
                sin_component = tf.sin(2 * np.pi * i * time / self.period)
                cos_component = tf.cos(2 * np.pi * i * time / self.period)
                harmonics.append(sin_component)
                harmonics.append(cos_component)
            return tf.stack(harmonics, axis=-1)

    # Custom Keras Layer for the Transformer Block (Dynamic Expert)
    class TransformerBlock(Layer):
        def __init__(self, embed_dim, num_heads, ff_dim, rate=0.1, **kwargs):
            super(TransformerBlock, self).__init__(**kwargs)
            # The MultiHeadAttention layer is the key component
            self.att = MultiHeadAttention(num_heads=num_heads, key_dim=embed_dim)
            self.ffn = tf.keras.Sequential(
                [Dense(ff_dim, activation="relu"), Dense(embed_dim),]
            )
            self.layernorm1 = LayerNormalization(epsilon=1e-6)
            self.layernorm2 = LayerNormalization(epsilon=1e-6)
            self.dropout1 = tf.keras.layers.Dropout(rate)
            self.dropout2 = tf.keras.layers.Dropout(rate)

        def call(self, inputs, training=False):
            # Self-attention: query, key, and value are all the same
            attn_output = self.att(inputs, inputs)
            attn_output = self.dropout1(attn_output, training=training)
            out1 = self.layernorm1(inputs + attn_output)
            ffn_output = self.ffn(out1)
            ffn_output = self.dropout2(ffn_output, training=training)
            return self.layernorm2(out1 + ffn_output)

    # The main MoE Model Definition (REVISED FOR MULTIVARIATE)
    class TimeSeriesMoE(Model):
        def __init__(self, input_len, output_len, num_features, num_experts=3, period=7, k=3, embed_dim=32, num_heads=4, **kwargs):
            super(TimeSeriesMoE, self).__init__(**kwargs)
            self.input_len = input_len
            self.output_len = output_len
            self.num_features = num_features
            self.num_experts = num_experts

            # This layer projects the input feature dimension to a higher dimension (embed_dim)
            self.input_projection = Dense(embed_dim)

            # 1. The Experts
            self.trend_expert = tf.keras.Sequential([
                tf.keras.layers.Flatten(),
                Dense(output_len)
            ], name="trend_expert")

            self.seasonality_expert = tf.keras.Sequential([
                FourierLayer(period=period, k=k),
                tf.keras.layers.Flatten(),
                Dense(output_len)
            ], name="seasonality_expert")

            self.dynamic_expert = tf.keras.Sequential([
                TransformerBlock(embed_dim=embed_dim, num_heads=num_heads, ff_dim=embed_dim*2),
                tf.keras.layers.Flatten(),
                Dense(output_len)
            ], name="dynamic_expert")

            self.experts = [self.trend_expert, self.seasonality_expert, self.dynamic_expert]

            # 2. The Gating Network: Flattens input to make a decision
            self.gating_network = tf.keras.Sequential([
                tf.keras.layers.Flatten(),
                Dense(64, activation='relu'),
                Dense(num_experts, activation='softmax')
            ], name="gating_network")

        def call(self, inputs):
            # Expected inputs shape: (batch_size, input_len, num_features)

            # Gating network uses the raw input sequence to decide weights
            gating_weights = self.gating_network(inputs)

            expert_outputs = []

            # Trend expert gets the raw multivariate sequence
            trend_out = self.experts[0](inputs)
            expert_outputs.append(trend_out)

            # Seasonality expert operates on time indices, not the values themselves
            time_indices = tf.range(start=0, limit=self.input_len, delta=1, dtype=tf.float32)
            time_indices_seq = tf.reshape(time_indices, (1, self.input_len, 1))
            batch_time_indices = tf.tile(time_indices_seq, [tf.shape(inputs)[0], 1, 1])
            seasonality_out = self.experts[1](batch_time_indices)
            expert_outputs.append(seasonality_out)

            # Dynamic expert gets the sequence AFTER it has been projected to a higher dimension
            projected_inputs = self.input_projection(inputs)
            dynamic_out = self.experts[2](projected_inputs)
            expert_outputs.append(dynamic_out)

            # Combine the expert outputs using the learned weights
            stacked_expert_outputs = tf.stack(expert_outputs, axis=1)
            expanded_weights = tf.expand_dims(gating_weights, axis=-1)
            weighted_outputs = expanded_weights * stacked_expert_outputs

            return tf.reduce_sum(weighted_outputs, axis=1)
        
        def evaluate_forecast(y_true, y_pred):
            y_true, y_pred = np.array(y_true), np.array(y_pred)
            mask = ~np.isnan(y_true) & ~np.isnan(y_pred)
            y_true, y_pred = y_true[mask], y_pred[mask]

            if len(y_true) == 0:
                return {'RMSE': np.nan, 'MAE': np.nan, 'MAPE': np.nan, 'wMAPE': np.nan, 'R2': np.nan}

            rmse = np.sqrt(mean_squared_error(y_true, y_pred))
            mae = mean_absolute_error(y_true, y_pred)
    
            # Original MAPE (prone to infinity on intermittent/volatile data)
            mape = np.mean(np.abs((y_true - y_pred) / y_true)) * 100 if np.all(y_true != 0) else np.nan
    
            # NEW: Volume-Weighted MAPE (wMAPE)
            sum_abs_error = np.sum(np.abs(y_true - y_pred))
            sum_actuals = np.sum(np.abs(y_true))
            wmape = (sum_abs_error / sum_actuals) * 100 if sum_actuals != 0 else np.nan

            r2 = r2_score(y_true, y_pred) if len(y_true) > 1 else np.nan

            return {'RMSE': rmse, 'MAE': mae, 'MAPE': mape, 'wMAPE': wmape, 'R2': r2}

# =================================================================
# MoE DEEP LEARNING ADDITIONS END
# =================================================================
# Inside app_96.py
import streamlit as st
import pandas as pd
import moe_engine  # The file created above

# Assuming 'data' is your loaded CSV dataframe
if st.button("Run 6-Month MoE + LLM Forecast (Parallel)"):
    with st.spinner(f"Processing over 3,000 SKUs across {moe_engine.MAX_WORKERS} CPU cores..."):
        
        # Run the massive parallel job
        final_forecast_df = moe_engine.run_moe_pipeline(data)
        
        st.success("MoE Forecast Completed Successfully!")
        
        # Display Results
        st.dataframe(final_forecast_df)
        
        # Allow user to download the generated forecast
        csv = final_forecast_df.to_csv(index=False).encode('utf-8')
        st.download_button(
            label="Download Final MoE Forecasts CSV",
            data=csv,
            file_name="MoE_Final_Forecasts_6Months.csv",
            mime="text/csv",
        )

# =================================================================
# Database Connection Function
# =================================================================
@st.cache_data(ttl=600) # Cache the data for 10 minutes
def load_data_from_mysql(host, user, password, db, query):
    """Connects to MySQL and executes a query to load data into a DataFrame."""
    if not create_engine:
        st.error("SQLAlchemy library not found. Please install it with 'pip install SQLAlchemy pymysql'")
        return None
    if not query.strip():
        st.warning("Query is empty. Skipping database load.")
        return None
    try:
        connection_str = f"mysql+pymysql://{user}:{quote_plus(password)}@{host}/{db}"
        engine = create_engine(connection_str)
        df = pd.read_sql(query, engine)
        return df
    except Exception as e:
        st.error(f"Failed to connect to the database or execute query: {e}")
        return None

import streamlit as st
import moe_engine

if st.button("Generate 6-Month MoE Forecast"):
    with st.spinner("Initializing Multi-Core Process Pool..."):
        # This will spin up the CPU cores, route to the LLM/XGB, and apply residual corrections
        forecast_df = moe_engine.run_parallel_forecast('MP-Till Apr 25.csv')
        st.success("State-of-the-Art Forecast Generated Successfully.")
        st.dataframe(forecast_df)

# =================================================================
# TimeSeriesEDA Class (MODIFIED FOR EDITABLE ANOMALIES)
# =================================================================

class TimeSeriesEDA:
    """
    A class to perform a comprehensive Exploratory Data Analysis on time series data.
    """
    def __init__(
        self,
        df: pd.DataFrame,
        date_col: str = 'date',
        sales_col: str = 'sales',
        country_code: str = 'US',
        contamination: float = 0.05,
        resample_freq: str = 'D', # This parameter receives the user's frequency selection
        date_format: str = None  # NEW PARAMETER
    ):
        if date_col not in df.columns or sales_col not in df.columns:
            raise ValueError(f"DataFrame must contain '{date_col}' and '{sales_col}' columns.")

        self.df = df.copy()
        self.date_col = date_col
        self.date_format = date_format # Store the format
        self.sales_col = sales_col
        self.country_code = country_code
        self.contamination = contamination
        self.resample_freq = resample_freq
        self.df_prepared = self._prepare_dataframe_before_cleaning()
        self.potential_anomalies_df = self._detect_anomalies(self.df_prepared)
        self.corrected_anomalies = {} # Will be populated after user interaction
        self.df_eda = self.df_prepared.copy() # Initially, df_eda is just the prepared data

    # def _prepare_dataframe_before_cleaning(self) -> pd.DataFrame:
    #     """Prepares dataframe up to the point of anomaly cleaning."""
    #     df_prepared = self.df.copy()
    #     df_prepared[self.date_col] = pd.to_datetime(df_prepared[self.date_col])
    #     df_prepared.dropna(subset=[self.date_col, self.sales_col], inplace=True)
    #     df_prepared = df_prepared.groupby(self.date_col)[self.sales_col].sum().reset_index()
    #     df_prepared = df_prepared.set_index(self.date_col)
    #     df_prepared = df_prepared.resample(self.resample_freq).sum().fillna(0)
    #     return df_prepared

    def _prepare_dataframe_before_cleaning(self) -> pd.DataFrame:
        """
        Prepares dataframe up to the point of anomaly cleaning.
        Only fixes date parsing / alignment; feature logic elsewhere is unchanged.
        """
        df_prepared = self.df.copy()

        # Robust date parsing
        df_prepared[self.date_col] = pd.to_datetime(
            df_prepared[self.date_col],
            format=self.date_format,  # Uses user format or None (for auto-detect)
            dayfirst=(self.date_format is None), # Fallback safety
            errors="coerce"
        )

        # Drop rows with bad dates or missing sales
        df_prepared.dropna(subset=[self.date_col, self.sales_col], inplace=True)

        # Aggregate to one row per date
        df_prepared = (
            df_prepared
            .groupby(self.date_col)[self.sales_col]
            .sum()
            .reset_index()
        )

        # Set index and sort
        df_prepared = df_prepared.set_index(self.date_col).sort_index()

        # Map high-level frequency to period-start labels so months line up with Excel
        freq_map = {
            'M': 'MS',   # Month start instead of month end
            'Q': 'QS',   # Quarter start
            'Y': 'YS'    # Year start
        }
        effective_freq = freq_map.get(self.resample_freq, self.resample_freq)

        # Resample to the chosen frequency and fill gaps with 0
        df_prepared = df_prepared.resample(effective_freq).sum().fillna(0)

        return df_prepared
        

    def _detect_anomalies(self, df: pd.DataFrame) -> pd.DataFrame:
        """Detects potential anomalies using Isolation Forest and returns them."""
        df_copy = df.copy()
        X = df_copy[[self.sales_col]]
        if len(X) < 2: return pd.DataFrame()

        model = IsolationForest(contamination=self.contamination, random_state=42)
        df_copy['anomaly_score'] = model.fit_predict(X)
        anomalies = df_copy[df_copy['anomaly_score'] == -1]

        country_holidays = set()
        if holidays:
            country_holidays = set(holidays.country_holidays(self.country_code, years=df_copy.index.year.unique()).keys())

        anomalies_to_review = []
        for date, row in anomalies.iterrows():
            is_holiday = date.date() in country_holidays
            anomalies_to_review.append({
                'Date': date,
                'Value': row[self.sales_col],
                'Is Holiday': is_holiday,
                'Suggested Action': 'Keep' if is_holiday else 'Correct',
                'Correct Anomaly': not is_holiday # Pre-select checkbox for non-holidays
            })

        return pd.DataFrame(anomalies_to_review)

    def apply_anomaly_corrections(self, edited_anomalies_df: pd.DataFrame):
        """Applies corrections based on the user-edited DataFrame of anomalies."""
        df_cleaned = self.df_prepared.copy()
        self.corrected_anomalies = {} # Reset corrections

        anomalies_to_correct = edited_anomalies_df[edited_anomalies_df['Correct Anomaly']]
        if anomalies_to_correct.empty:
            st.info("No anomalies were selected for correction.")
            self.df_eda = df_cleaned.drop(columns=['anomaly_score'], errors='ignore')
            return

        rolling_mean = df_cleaned[self.sales_col].rolling(window=14, min_periods=1).mean()

        for _, row in anomalies_to_correct.iterrows():
            date = row['Date']
            original_value = row['Value']
            replacement_value = rolling_mean.loc[date]
            self.corrected_anomalies[date] = {'original': original_value, 'replaced_with': replacement_value}
            df_cleaned.loc[date, self.sales_col] = replacement_value

        self.df_eda = df_cleaned.drop(columns=['anomaly_score'], errors='ignore')
        st.success(f"Applied corrections to {len(self.corrected_anomalies)} anomalies.")

    def display_data_summary_and_distribution(self):
        """Displays data quality metrics and plots the distribution of the target variable."""
        st.subheader("Data Quality & Summary")
        original_records = len(self.df)
        min_date = pd.to_datetime(self.df[self.date_col]).min()
        max_date = pd.to_datetime(self.df[self.date_col]).max()
        missing_values = self.df[self.sales_col].isnull().sum()

        summary_metrics = {
            "Total Records (Original)": f"{original_records}",
            "Min Date": f"{min_date.strftime('%Y-%m-%d')}",
            "Max Date": f"{max_date.strftime('%Y-%m-%d')}",
            "Missing Values": f"{missing_values}",
            "Resampling Frequency": f"{self.resample_freq}"
        }

        col1, col2, col3, col4, col5 = st.columns(5)
        col1.metric("Total Records (Original)", summary_metrics["Total Records (Original)"])
        col2.metric("Min Date", summary_metrics["Min Date"])
        col3.metric("Max Date", summary_metrics["Max Date"])
        col4.metric("Missing Values", summary_metrics["Missing Values"])
        col5.metric("Resampling Frequency", summary_metrics["Resampling Frequency"])
        st.caption(f"Data has been resampled to **{self.resample_freq}** frequency. Missing values within the resampled series are filled with 0 before anomaly cleaning.")

        st.subheader("Target Variable Distribution")
        df_plot = self.df_eda.copy()

        df_plot['month'] = df_plot.index.month_name()
        df_plot['day_of_week'] = df_plot.index.day_name()
        df_plot['week_of_year'] = df_plot.index.isocalendar().week.astype(int)
        df_plot['quarter'] = df_plot.index.to_period('Q').astype(str)

        month_order = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
        day_order = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

        if self.resample_freq == 'D':
            fig = make_subplots(rows=4, cols=1, subplot_titles=("Overall Distribution", "Monthly Distribution", "Weekly Distribution", "Day of Week Distribution"))
            fig.add_trace(go.Histogram(x=df_plot[self.sales_col], name='Frequency'), row=1, col=1)
            fig.add_trace(go.Box(x=df_plot['month'], y=df_plot[self.sales_col], name='Monthly'), row=2, col=1)
            fig.add_trace(go.Box(x=df_plot['week_of_year'], y=df_plot[self.sales_col], name='Weekly'), row=3, col=1)
            fig.add_trace(go.Box(x=df_plot['day_of_week'], y=df_plot[self.sales_col], name='Daily'), row=4, col=1)

            fig.update_xaxes(categoryorder='array', categoryarray=month_order, row=2, col=1)
            fig.update_xaxes(title_text="Week of Year", row=3, col=1)
            fig.update_xaxes(categoryorder='array', categoryarray=day_order, row=4, col=1)
            fig.update_layout(height=1000)

        elif self.resample_freq == 'W':
            fig = make_subplots(rows=3, cols=1, subplot_titles=("Overall Distribution", "Monthly Distribution", "Weekly Distribution"))
            fig.add_trace(go.Histogram(x=df_plot[self.sales_col], name='Frequency'), row=1, col=1)
            fig.add_trace(go.Box(x=df_plot['month'], y=df_plot[self.sales_col], name='Monthly'), row=2, col=1)
            fig.add_trace(go.Box(x=df_plot['week_of_year'], y=df_plot[self.sales_col], name='Weekly'), row=3, col=1)

            fig.update_xaxes(categoryorder='array', categoryarray=month_order, row=2, col=1)
            fig.update_xaxes(title_text="Week of Year", row=3, col=1)
            fig.update_layout(height=800)

        else: # For Monthly, Quarterly, Yearly
            fig = make_subplots(rows=2, cols=1, subplot_titles=("Overall Distribution", "Distribution by Period"))
            fig.add_trace(go.Histogram(x=df_plot[self.sales_col], name='Frequency'), row=1, col=1)

            if self.resample_freq == 'M':
                fig.add_trace(go.Box(x=df_plot['month'], y=df_plot[self.sales_col], name='Monthly'), row=2, col=1)
                fig.update_xaxes(categoryorder='array', categoryarray=month_order, row=2, col=1)
            elif self.resample_freq == 'Q':
                fig.add_trace(go.Box(x=df_plot['quarter'], y=df_plot[self.sales_col], name='Quarterly'), row=2, col=1)

            fig.update_layout(height=600)

        fig.update_layout(title_text=f'Distribution of {self.sales_col}', showlegend=False)
        st.plotly_chart(fig, use_container_width=True)
        return fig, summary_metrics

    def plot_trend(self):
        fig = px.line(self.df_eda, x=self.df_eda.index, y=self.sales_col, title=f'{self.sales_col} Over Time')
        fig.update_layout(xaxis_title='Date', yaxis_title=self.sales_col)
        st.plotly_chart(fig, use_container_width=True)
        return fig

    def plot_decomposition(self):
        periods = {'D': 7, 'W': 4, 'M': 12, 'Q': 4, 'Y': 2}
        period = periods.get(self.resample_freq, 4)

        if len(self.df_eda) > period * 2:
            decomposition = seasonal_decompose(self.df_eda[self.sales_col], model='additive', period=period)

            fig = make_subplots(rows=4, cols=1, shared_xaxes=True, subplot_titles=("Observed", "Trend", "Seasonal", "Residuals"))
            fig.add_trace(go.Scatter(x=decomposition.observed.index, y=decomposition.observed, mode='lines', name='Observed'), row=1, col=1)
            fig.add_trace(go.Scatter(x=decomposition.trend.index, y=decomposition.trend, mode='lines', name='Trend'), row=2, col=1)
            fig.add_trace(go.Scatter(x=decomposition.seasonal.index, y=decomposition.seasonal, mode='lines', name='Seasonal'), row=3, col=1)
            fig.add_trace(go.Scatter(x=decomposition.resid.index, y=decomposition.resid, mode='markers', name='Residuals'), row=4, col=1)

            fig.update_layout(height=700, title_text='Time Series Decomposition', showlegend=False)
            st.plotly_chart(fig, use_container_width=True)
            st.caption(f"Decomposition performed with a period of {period} ({self.resample_freq}).")
            return fig
        else:
            st.warning("Not enough data for meaningful decomposition at the selected frequency.")
            return None

    def create_anomaly_plot_fig_with_stats(self):
        """Creates the anomaly plot figure based on the latest df_eda and corrected_anomalies."""
        fig = go.Figure()

        # Plot the base series (which is now the corrected one)
        fig.add_trace(go.Scatter(x=self.df_eda.index, y=self.df_eda[self.sales_col], mode='lines', name=f'{self.sales_col} (Cleaned)'))

        # Plot markers for the points that were corrected
        if self.corrected_anomalies:
            dates = list(self.corrected_anomalies.keys())
            original_values = [v['original'] for v in self.corrected_anomalies.values()]
            fig.add_trace(go.Scatter(
                x=dates, y=original_values, mode='markers', name='Anomalies (Corrected)',
                marker=dict(color='red', symbol='x', size=10)
            ))

        # Plot markers for anomalies that were identified but KEPT by the user
        if not self.potential_anomalies_df.empty and 'edited_anomalies_df' in st.session_state:
             kept_anomalies_df = st.session_state.edited_anomalies_df[st.session_state.edited_anomalies_df['Correct Anomaly'] == False]
             if not kept_anomalies_df.empty:
                fig.add_trace(go.Scatter(
                    x=kept_anomalies_df['Date'], y=kept_anomalies_df['Value'],
                    mode='markers', name='Anomalies (Kept by User)',
                    marker=dict(color='green', symbol='circle-open', size=12, line=dict(width=2))
                ))

        fig.update_layout(
            title_text='Anomaly Detection and Correction',
            xaxis_title='Date', yaxis_title=self.sales_col,
            legend=dict(orientation="h", yanchor="top", y=1.1, xanchor="left", x=0.01)
        )

        total_potential = len(self.potential_anomalies_df)
        corrected_count = len(self.corrected_anomalies)
        kept_count = total_potential - corrected_count

        return fig, total_potential, corrected_count, kept_count

    def plot_anomaly_detection(self):
        """Displays the anomaly plot in the UI."""
        fig, total_count, corrected_count, kept_count = self.create_anomaly_plot_fig_with_stats()

        if fig:
            st.info(f"Anomaly detection is performed on the data after resampling to frequency '{self.resample_freq}'.")
            st.plotly_chart(fig, use_container_width=True)
            st.info(f"Identified **{total_count}** total potential anomalies. Based on your review, **{corrected_count}** anomalies were corrected and **{kept_count}** were kept.")
        else:
            st.warning("Could not generate anomaly plot.")
        return fig

    def plot_correlation_heatmap(self):
        df_featured = self._engineer_features()
        df_featured.rename(columns={'sales': self.sales_col}, inplace=True)
        features_to_correlate = [self.sales_col, 'day_of_week', 'month', 'week_of_year', 'quarter', 'lag_1', 'lag_4', 'rolling_mean_4', 'rolling_std_4', 'is_holiday', 'days_to_next_holiday', 'days_from_prev_holiday']

        # Add exogenous features to correlation heatmap if they exist
        if 'exog_df' in st.session_state and st.session_state.exog_df is not None:
            features_to_correlate.extend(st.session_state.exog_df.columns)

        features_to_correlate = [f for f in features_to_correlate if f in df_featured.columns]

        if not features_to_correlate:
            st.warning("No features available for correlation heatmap.")
            return None

        correlation_matrix = df_featured[features_to_correlate].corr()
        fig = px.imshow(correlation_matrix, text_auto=True, aspect="auto", color_continuous_scale='RdBu_r', title=f'Correlation Heatmap of Features and {self.sales_col}')
        st.plotly_chart(fig, use_container_width=True)
        return fig

    def plot_acf_pacf(self, lags: int = 20):
        try:
            conf_level = 0.05
            # Ensure there are enough data points
            if len(self.df_eda[self.sales_col]) <= lags:
                st.warning(f"Not enough data points to compute ACF/PACF for {lags} lags. Skipping.")
                return None

            acf_values, acf_confint = acf(self.df_eda[self.sales_col], nlags=lags, alpha=conf_level)
            pacf_values, pacf_confint = pacf(self.df_eda[self.sales_col], nlags=lags, alpha=conf_level)

            fig = make_subplots(rows=1, cols=2, subplot_titles=("Autocorrelation (ACF)", "Partial Autocorrelation (PACF)"))

            # ACF Plot
            fig.add_trace(go.Scatter(x=np.arange(lags + 1), y=acf_confint[:, 0] - acf_values, mode='lines', line=dict(color='rgba(0,0,0,0)'), showlegend=False), row=1, col=1)
            fig.add_trace(go.Scatter(x=np.arange(lags + 1), y=acf_confint[:, 1] - acf_values, mode='lines', line=dict(color='rgba(0,0,0,0)'), fill='tonexty', fillcolor='rgba(0,100,80,0.2)', showlegend=False), row=1, col=1)
            fig.add_trace(go.Bar(x=np.arange(lags + 1), y=acf_values, name='ACF'), row=1, col=1)

            # PACF Plot
            fig.add_trace(go.Scatter(x=np.arange(lags + 1), y=pacf_confint[:, 0] - pacf_values, mode='lines', line=dict(color='rgba(0,0,0,0)'), showlegend=False), row=1, col=2)
            fig.add_trace(go.Scatter(x=np.arange(lags + 1), y=pacf_confint[:, 1] - pacf_values, mode='lines', line=dict(color='rgba(0,0,0,0)'), fill='tonexty', fillcolor='rgba(0,100,80,0.2)', showlegend=False), row=1, col=2)
            fig.add_trace(go.Bar(x=np.arange(lags + 1), y=pacf_values, name='PACF'), row=1, col=2)

            fig.update_layout(height=400, title_text='ACF and PACF Plots', showlegend=False)
            st.plotly_chart(fig, use_container_width=True)
            return fig
        except Exception as e:
            st.warning(f"Could not generate ACF/PACF plots. Error: {e}")
            return None

    def analyze_holidays(self):
        if not holidays:
            st.warning("'holidays' library not installed. Skipping.")
            return None

        years = self.df_eda.index.year.unique()
        country_holidays_dict = holidays.country_holidays(self.country_code, years=years)

        if not country_holidays_dict:
            st.info(f"No holidays found for country '{self.country_code}' in the date range.")
            return None

        holiday_dates = pd.to_datetime(list(country_holidays_dict.keys()))
        df_with_holidays = self.df_eda.copy()
        df_with_holidays['is_holiday'] = df_with_holidays.index.isin(holiday_dates)

        holiday_sales = df_with_holidays[df_with_holidays['is_holiday']]

        fig = go.Figure()
        fig.add_trace(go.Scatter(x=self.df_eda.index, y=self.df_eda[self.sales_col], mode='lines', name=self.sales_col))
        if not holiday_sales.empty:
            fig.add_trace(go.Scatter(x=holiday_sales.index, y=holiday_sales[self.sales_col], mode='markers', name='Holidays', marker=dict(color='green', size=10)))

        fig.update_layout(title=f'{self.sales_col} with Holidays Highlighted', xaxis_title='Date', yaxis_title=self.sales_col, legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1))
        st.plotly_chart(fig, use_container_width=True)

        avg_holiday = holiday_sales[self.sales_col].mean()
        avg_non_holiday = df_with_holidays[~df_with_holidays['is_holiday']][self.sales_col].mean()
        col1, col2 = st.columns(2)
        col1.metric(f"Average {self.sales_col} on Holidays", f"{avg_holiday:.2f}")
        col2.metric(f"Average {self.sales_col} on Non-Holidays", f"{avg_non_holiday:.2f}")
        return fig

    def _engineer_features(self, use_tsfresh: bool = False, df_override: pd.DataFrame = None) -> pd.DataFrame: # Added df_override
            # --- FIX: Use df_override if provided, otherwise use self.df_eda ---
            df_to_feature = self.df_eda.copy() if df_override is None else df_override.copy()
            if not isinstance(df_to_feature.index, pd.DatetimeIndex):
                 # Ensure index is datetime if df_override is passed without it (e.g., from reset_index)
                 if 'date' in df_to_feature.columns:
                     df_to_feature['date'] = pd.to_datetime(df_to_feature['date'])
                     df_to_feature = df_to_feature.set_index('date')
                 else: # Try using the first column if 'date' isn't present
                     date_col_name = df_to_feature.columns[0]
                     df_to_feature[date_col_name] = pd.to_datetime(df_to_feature[date_col_name])
                     df_to_feature = df_to_feature.set_index(date_col_name)
    
            df_featured = df_to_feature.reset_index()
            # --- END FIX ---
    
            # Robustly find and rename the date column that was the index
            date_col_name = df_to_feature.index.name or 'index'
            if date_col_name not in df_featured.columns and 'index' in df_featured.columns:
                date_col_name = 'index' # Handle reset_index case
            elif date_col_name not in df_featured.columns:
                 date_col_name = df_featured.columns[0] # Fallback if name is unexpected
    
            df_featured.rename(columns={
                date_col_name: 'date',
                self.sales_col: 'sales'
            }, inplace=True, errors='ignore')
    
    
            freq = self.resample_freq
    
            # --- Standard Feature Engineering ---
            if freq == 'D':
                df_featured['day_of_week'] = df_featured['date'].dt.dayofweek
                df_featured['day_of_week_sin'] = np.sin(2 * np.pi * df_featured['day_of_week']/7)
                df_featured['day_of_week_cos'] = np.cos(2 * np.pi * df_featured['day_of_week']/7)
                lags = [7, 14, 28]; windows = [7, 14, 28]
            elif freq == 'W':
                lags = [1, 4, 8]; windows = [4, 8]
            elif freq == 'M':
                lags = [1, 6, 12]; windows = [3, 6]
            elif freq == 'Q':
                lags = [1, 2, 4]; windows = [2, 4]
            else: # Yearly
                lags = [1, 2]; windows = [1, 2]
    
            df_featured['month'] = df_featured['date'].dt.month
            df_featured['week_of_year'] = df_featured['date'].dt.isocalendar().week.astype(int)
            df_featured['quarter'] = df_featured['date'].dt.quarter
            df_featured['month_sin'] = np.sin(2 * np.pi * df_featured['month']/12)
            df_featured['month_cos'] = np.cos(2 * np.pi * df_featured['month']/12)
    
            for lag in lags: df_featured[f'lag_{lag}'] = df_featured['sales'].shift(lag).fillna(0)
            for window in windows:
                df_featured[f'rolling_mean_{window}'] = df_featured['sales'].shift(1).rolling(window=window).mean().fillna(0)
                df_featured[f'rolling_std_{window}'] = df_featured['sales'].shift(1).rolling(window=window).std().fillna(0)
    
            if holidays:
                years = df_featured['date'].dt.year.unique()
                min_year = years.min() if len(years) > 0 else pd.Timestamp.now().year # Handle empty df_override case
                max_year = years.max() if len(years) > 0 else pd.Timestamp.now().year
                country_holidays = holidays.country_holidays(self.country_code, years=np.arange(min_year - 1, max_year + 2))
    
                if country_holidays:
                    holiday_dates = pd.DataFrame(list(country_holidays.items()), columns=['date', 'holiday_name'])
                    holiday_dates['date'] = pd.to_datetime(holiday_dates['date'])
                    holiday_dates.sort_values('date', inplace=True)
    
                    df_featured['is_holiday'] = df_featured['date'].isin(holiday_dates['date']).astype(int)
                    holiday_dates_prev = holiday_dates.rename(columns={'date': 'date_prev'})
                    holiday_dates_next = holiday_dates.rename(columns={'date': 'date_next'})
    
                    # Ensure 'date' column is sorted before merge_asof
                    df_featured = df_featured.sort_values('date')
    
                    df_featured = pd.merge_asof(df_featured, holiday_dates_prev, left_on='date', right_on='date_prev', direction='backward')
                    df_featured = pd.merge_asof(df_featured, holiday_dates_next, left_on='date', right_on='date_next', direction='forward')
    
                    df_featured['days_to_next_holiday'] = (df_featured['date_next'] - df_featured['date']).dt.days
                    df_featured['days_from_prev_holiday'] = (df_featured['date'] - df_featured['date_prev']).dt.days
                    df_featured.fillna({'days_to_next_holiday': 365, 'days_from_prev_holiday': 365}, inplace=True)
                    df_featured.drop(columns=['holiday_name_x', 'date_prev', 'holiday_name_y', 'date_next'], inplace=True, errors='ignore')
                else:
                     df_featured['is_holiday'] = 0; df_featured['days_to_next_holiday'] = 365; df_featured['days_from_prev_holiday'] = 365
    
            # --- TSFRESH FEATURE ENGINEERING (OPTIONAL) ---
            if use_tsfresh and extract_features:
                st.info("Performing advanced feature engineering with tsfresh... This may take a moment.")
                df_tsfresh = df_featured[['date', 'sales']].dropna(subset=['sales'])
                df_tsfresh['id'] = 1 # A dummy id for tsfresh
    
                # Use a rolling window to extract features
                df_rolled = roll_time_series(df_tsfresh, column_id='id', column_sort='date',
                                             max_timeshift=10, min_timeshift=10)
    
                if not df_rolled.empty:
                    X_tsfresh = extract_features(df_rolled, column_id='id', column_sort='date',
                                                 default_fc_parameters=MinimalFCParameters(),
                                                 disable_progressbar=True)
                    X_tsfresh.index = X_tsfresh.index.droplevel(0)
                    # Clean up column names for compatibility
                    X_tsfresh.columns = [c.replace('"', '').replace("'", "").replace("(", "_").replace(")", "").replace(",", "_") for c in X_tsfresh.columns]
    
                    # Merge tsfresh features back into the main feature dataframe
                    df_featured = df_featured.merge(X_tsfresh, left_on='date', right_index=True, how='left')
                    df_featured.fillna(method='ffill', inplace=True)
                    df_featured.fillna(0, inplace=True)
    
            df_featured.set_index('date', inplace=True)
            # --- FIX: Only join exog_df if df_override is None (i.e., when running normally, not iteratively) ---
            if df_override is None and 'exog_df' in st.session_state and st.session_state.exog_df is not None:
                 df_featured = df_featured.join(st.session_state.exog_df, how='left').fillna(method='ffill').fillna(0)
            # --- END FIX ---
    
            return df_featured.reset_index()
# =================================================================
# TimeSeriesForecaster Class (MODIFIED FOR NEW MODELS, AND CIs)
# =================================================================
class TimeSeriesForecaster:
    def __init__(self, eda_analyzer: TimeSeriesEDA, proxy_files_data: List[Tuple[str, pd.DataFrame]] = None, new_product_start_date: str = None):
        self.eda = eda_analyzer
        self.proxy_files_data = proxy_files_data
        self.new_product_start_date = new_product_start_date
        self.performance_results = []
        self.last_error_model = None
        self.last_X_train_columns = None
        self.last_run_details = []
        self.exog_forecast = None # <-- MODIFICATION: Added to store future exog

    def _calculate_mape(self, y_true, y_pred) -> float:
        y_true, y_pred = np.array(y_true), np.array(y_pred)
        non_zero_mask = y_true != 0
        if not np.any(non_zero_mask): return 0.0
        return np.mean(np.abs((y_true[non_zero_mask] - y_pred[non_zero_mask]) / y_true[non_zero_mask])) * 100

    def _find_best_proxy(self) -> Tuple[pd.DataFrame, str, float]:
        if not dtw: raise ImportError("dtaidistance library not found.")
        st.info("--- Finding best proxy product using DTW ---")
        main_series, best_proxy_df, min_distance = self.eda.df_eda[self.eda.sales_col], None, float('inf')
        best_proxy_name = None

        for filename, proxy_df in self.proxy_files_data:
            product_name = filename.rsplit('.', 1)[0] if '.' in filename else filename

            proxy_numeric_cols = proxy_df.select_dtypes(include=np.number).columns.tolist()
            if not proxy_numeric_cols:
                st.warning(f"Proxy '{product_name}' has no numeric columns to use for sales. Skipping.")
                continue

            proxy_sales_col = proxy_numeric_cols[0]

            proxy_df_renamed = proxy_df.rename(columns={proxy_sales_col: self.eda.sales_col})
            proxy_eda = TimeSeriesEDA(proxy_df_renamed, self.eda.date_col, self.eda.sales_col, self.eda.country_code, contamination=self.eda.contamination, resample_freq=self.eda.resample_freq)
            proxy_eda.df_eda = proxy_eda.df_prepared.copy() # Use uncleaned data for proxy finding

            aligned_main, aligned_proxy = main_series.align(proxy_eda.df_eda[self.eda.sales_col], join='inner')
            if len(aligned_main) < 14: continue

            scaler = MinMaxScaler()
            main_norm = scaler.fit_transform(aligned_main.values.reshape(-1, 1)).flatten()
            proxy_norm = scaler.fit_transform(aligned_proxy.values.reshape(-1, 1)).flatten()

            distance = dtw.distance(main_norm, proxy_norm)

            st.write(f"  DTW distance for proxy '{product_name}': {distance:.2f}")
            if distance < min_distance:
                min_distance, best_proxy_df, best_proxy_name = distance, proxy_df_renamed, product_name

        if best_proxy_df is None: raise ValueError("Could not find a suitable proxy. Ensure proxy products have overlapping date ranges with the new product.")
        return best_proxy_df, best_proxy_name, min_distance

    def _get_combined_eda(self) -> TimeSeriesEDA:
        st.info("--- Short history detected. Combining proxy and actual data. ---")
        best_proxy_df, best_proxy_name, min_distance = self._find_best_proxy()

        st.markdown("---")
        st.subheader("New Product Analysis: Proxy Identification")
        st.success(f"**Most Similar Product Found:** '{best_proxy_name}'")
        col1, col2 = st.columns(2)
        col1.metric(label="Similarity Score (DTW Distance)", value=f"{min_distance:.2f}")
        with col2:
            st.write("")
            st.info("Lower DTW Distance indicates higher similarity.")
        st.caption("This product's historical pattern will be used to extend the new product's short history for a more reliable forecast.")
        st.markdown("---")

        proxy_eda = TimeSeriesEDA(best_proxy_df, self.eda.date_col, self.eda.sales_col, self.eda.country_code, contamination=self.eda.contamination, resample_freq=self.eda.resample_freq)
        proxy_eda.df_eda = proxy_eda.df_prepared.copy() # Use uncleaned proxy data
        start_date = pd.to_datetime(self.new_product_start_date)
        scaling_window = pd.Timedelta(days=min(14, len(self.eda.df_eda[self.eda.df_eda.index >= start_date]) - 1))
        if scaling_window.days < 1: raise ValueError("Not enough new product data to scale. A minimum of 2 data points is required.")
        avg_new_product_sales = self.eda.df_eda.loc[start_date : start_date + scaling_window, self.eda.sales_col].mean()
        proxy_scaling_start_date = start_date - pd.DateOffset(years=1)
        proxy_sales_in_window = proxy_eda.df_eda[self.eda.sales_col].loc[proxy_scaling_start_date:proxy_scaling_start_date + scaling_window]
        avg_proxy_sales = proxy_sales_in_window.mean() if not proxy_sales_in_window.empty else avg_new_product_sales
        scaling_factor = avg_new_product_sales / avg_proxy_sales if avg_proxy_sales > 0 else 1.0
        st.write(f"Using scaling factor of {scaling_factor:.2f} for proxy data.")
        scaled_proxy_sales = proxy_eda.df_eda[self.eda.sales_col] * scaling_factor
        scaled_proxy_sales.index += pd.DateOffset(years=1)
        combined_sales = pd.concat([scaled_proxy_sales[scaled_proxy_sales.index < start_date], self.eda.df_eda[self.eda.sales_col]])
        combined_sales = combined_sales[~combined_sales.index.duplicated(keep='last')]

        # Create a new EDA object for the combined data, this time it will go through the full init
        combined_eda = TimeSeriesEDA(pd.DataFrame(combined_sales).reset_index(), self.eda.date_col, self.eda.sales_col, self.eda.country_code, contamination=self.eda.contamination, resample_freq=self.eda.resample_freq)
        # We need to manually trigger the final cleaning step since it now depends on user input
        # For proxy logic, we assume auto-correction is desired
        edited_anomalies = combined_eda.potential_anomalies_df.copy()
        combined_eda.apply_anomaly_corrections(edited_anomalies)
        return combined_eda

    # --- MODELING METHODS (UPDATED) ---
    def _forecast_auto_arima(self, train_data, n_periods, exog_train, exog_forecast, **kwargs):
        if not pm: raise ImportError("pmdarima library not found.")
        seasonal_periods = {'D': 7, 'W': 52, 'M': 12, 'Q': 4, 'Y': 1}.get(self.eda.resample_freq, 0)

        model = pm.auto_arima(train_data[self.eda.sales_col], X=exog_train,
                              m=seasonal_periods, seasonal=True, suppress_warnings=True,
                              stepwise=True, error_action='ignore')

        fitted = pd.Series(model.predict_in_sample(X=exog_train), index=train_data.index)
        forecast, conf_int = model.predict(n_periods=n_periods, X=exog_forecast, return_conf_int=True)

        forecast_ci = pd.DataFrame(conf_int, index=forecast.index, columns=['lower', 'upper'])
        return fitted, forecast, forecast_ci, model

    def _forecast_prophet(self, train_data, n_periods, exog_train, exog_forecast, **kwargs):
        if not Prophet: raise ImportError("Prophet library not found.")

        # 1. Map to effective frequency to prevent Month Start vs Month End mismatches
        freq_map = {'M': 'MS', 'Q': 'QS', 'Y': 'YS'}
        effective_freq = freq_map.get(self.eda.resample_freq, self.eda.resample_freq)

        prophet_df = train_data.reset_index()
        prophet_df.rename(columns={self.eda.date_col: 'ds', self.eda.sales_col: 'y'}, inplace=True)

        if exog_train is not None:
            prophet_df = prophet_df.merge(exog_train, left_on='ds', right_index=True)

        model = Prophet()

        if exog_train is not None:
            for col in exog_train.columns:
                model.add_regressor(col)

        model.fit(prophet_df)

        # Use effective_freq here
        future = model.make_future_dataframe(periods=n_periods, freq=effective_freq)

        if exog_forecast is not None:
            # 2. Combine train and forecast exog to prevent NaNs in historical dates
            if exog_train is not None:
                all_exog = pd.concat([exog_train, exog_forecast])
            else:
                all_exog = exog_forecast
                
            future = future.merge(all_exog, left_on='ds', right_index=True, how='left')
            future = future.ffill().bfill()

        forecast_df = model.predict(future)
        fitted = forecast_df['yhat'][:-n_periods]; fitted.index = train_data.index

        forecast_part = forecast_df.iloc[-n_periods:]
        forecasted = pd.Series(forecast_part['yhat'].values, index=pd.date_range(start=train_data.index[-1], periods=n_periods + 1, freq=effective_freq)[1:])
        forecast_ci = forecast_part[['yhat_lower', 'yhat_upper']].rename(columns={'yhat_lower': 'lower', 'yhat_upper': 'upper'})
        forecast_ci.index = forecasted.index

        return fitted, forecasted, forecast_ci, (forecast_df, model)

    def _forecast_exponential_smoothing(self, train_data, n_periods, **kwargs):
        model = ExponentialSmoothing(train_data[self.eda.sales_col], initialization_method="estimated").fit()
        fitted = model.fittedvalues
        forecast = model.forecast(n_periods)
        # Note: Basic ES doesn't provide easy confidence intervals. Returning None.
        return fitted, forecast, None, model

    def _forecast_holt_winters(self, train_data, n_periods, **kwargs):
        seasonal_periods = {'D': 7, 'W': 52, 'M': 12, 'Q': 4, 'Y': 1}.get(self.eda.resample_freq, 0)

        if seasonal_periods > 1 and len(train_data) > 2 * seasonal_periods:
            model_fit = ExponentialSmoothing(train_data[self.eda.sales_col], seasonal_periods=seasonal_periods, seasonal='add', initialization_method="estimated").fit()
        else:
             model_fit = ExponentialSmoothing(train_data[self.eda.sales_col], initialization_method="estimated").fit()

        fitted = model_fit.fittedvalues

        try:
            # Try to get forecast and confidence intervals using modern method
            forecast_pred = model_fit.get_forecast(n_periods)
            forecast = forecast_pred.predicted_mean
            forecast_ci = forecast_pred.conf_int()
            forecast_ci.columns = ['lower', 'upper']
        except AttributeError:
            # Fallback for older statsmodels versions
            forecast = model_fit.forecast(n_periods)
            forecast_ci = None

        return fitted, forecast, forecast_ci, model_fit

    # --- UPDATED MODEL: ARIMA ---
    def _forecast_arima(self, train_data, n_periods, **kwargs):
        """Forecasts using a simple ARIMA(1,1,1) model. Ignores exogenous features."""
        # --- FIX: Always fit as univariate, ignore exog ---
        # No check for kwargs.get('exog_train') needed here anymore
        model_fit = ARIMA(train_data[self.eda.sales_col], order=(1,1,1)).fit()
        fitted = model_fit.fittedvalues

        # Get forecast and confidence intervals
        forecast_pred = model_fit.get_forecast(steps=n_periods) # Use steps=n_periods
        forecast = forecast_pred.predicted_mean
        forecast_ci = forecast_pred.conf_int()
        forecast_ci.columns = ['lower', 'upper']

        return fitted, forecast, forecast_ci, model_fit # Return model_fit
        # --- END FIX ---

    # --- UPDATED MODEL: SARIMAX (FIXED) ---
    def _forecast_sarimax(self, train_data, n_periods, exog_train, exog_forecast, **kwargs):
        """Forecasts using SARIMAX. Uses exog if provided, otherwise univariate."""
        seasonal_periods = {'D': 7, 'W': 52, 'M': 12, 'Q': 4, 'Y': 1}.get(self.eda.resample_freq, 0)

        # --- FIX: Conditional exog usage ---
        if exog_train is not None:
             # Fit with exog if provided (meaning external data was loaded)
             model_fit = SARIMAX(train_data[self.eda.sales_col], exog=exog_train,
                            order=(1,1,1),
                            seasonal_order=(1,1,0,seasonal_periods),
                            enforce_stationarity=False,
                            enforce_invertibility=False).fit(disp=False)
             fitted = model_fit.fittedvalues # Use fittedvalues
             forecast_pred = model_fit.get_forecast(steps=n_periods, exog=exog_forecast) # Use steps=n_periods
        else:
            # Fit without exog (no external data loaded)
            model_fit = SARIMAX(train_data[self.eda.sales_col],
                            order=(1,1,1),
                            seasonal_order=(1,1,0,seasonal_periods),
                            enforce_stationarity=False,
                            enforce_invertibility=False).fit(disp=False)
            fitted = model_fit.fittedvalues # Use fittedvalues
            forecast_pred = model_fit.get_forecast(steps=n_periods) # Forecast without exog, Use steps=n_periods
        # --- END FIX ---

        forecast = forecast_pred.predicted_mean
        forecast_ci = forecast_pred.conf_int()
        forecast_ci.columns = ['lower', 'upper']

        return fitted, forecast, forecast_ci, model_fit # Return model_fit
    

    # --- NEW MODEL: LIGHTGBM ---
    def _forecast_lightgbm(self, train_data, n_periods, exog_train=None, exog_forecast=None, use_tsfresh=False, **kwargs):
        if not lgb: raise ImportError("lightgbm library not found.")

        # Engineer features on the full history
        full_df = self.eda.df_eda
        full_features_df = self.eda._engineer_features(use_tsfresh=use_tsfresh).set_index('date')

        # Align features with the training data for this split
        train_features_df = full_features_df.loc[train_data.index]

        y_train = train_features_df['sales']
        X_train = train_features_df.drop(columns=['sales'])

        model = lgb.LGBMRegressor(random_state=42, verbose=-1) # verbose=-1 suppresses warnings
        model.fit(X_train, y_train)

        fitted = pd.Series(model.predict(X_train), index=X_train.index)

        # Iterative forecasting
        history = full_features_df.copy()
        forecast_values = []

        # Get the actual future dates from the exogenous forecast dataframe's index
        forecast_dates = exog_forecast.index if exog_forecast is not None else pd.date_range(start=train_data.index[-1], periods=n_periods + 1, freq=self.eda.resample_freq)[1:]

        for date in forecast_dates:
            # Get the pre-calculated features for the next step from exog_forecast
            # --- FIX: Ensure exog_forecast exists before using .loc ---
            if exog_forecast is not None:
                X_next = exog_forecast.loc[[date]]
                # Align columns with training columns
                X_next = X_next.reindex(columns=X_train.columns, fill_value=0)
                next_pred = model.predict(X_next)[0]
            else:
                 # If no exog, predict based on features derived only from history (not ideal for LGBM)
                 # This branch shouldn't ideally be hit if exog_train was used, but handles edge case
                 # Re-engineer features for the single point needed (less efficient)
                 # We need the *last* known data point to generate features for the *next* step
                 last_known_date = train_data.index[-1] if not forecast_values else forecast_dates[len(forecast_values)-1]
                 temp_df_for_features = self.eda.df_eda.loc[:last_known_date].iloc[[-1]].copy() # Get last row
                 if forecast_values: # Update sales value if forecasting iteratively
                     temp_df_for_features[self.eda.sales_col] = forecast_values[-1]

                 temp_engineered = self.eda._engineer_features(use_tsfresh=False, df_override=temp_df_for_features.reset_index()) # Create features for this point
                 X_next = temp_engineered.set_index('date').drop(columns=['sales'])
                 X_next = X_next.reindex(columns=X_train.columns, fill_value=0)
                 next_pred = model.predict(X_next)[0]


            forecast_values.append(next_pred)
            # --- END FIX ---


        forecast = pd.Series(forecast_values, index=forecast_dates)

        return fitted, forecast, None, model # LGBM doesn't natively support CIs

    def _forecast_dl_moe(self, train_data, n_periods, exog_train=None, exog_forecast=None, **kwargs):
        """Trains and forecasts using the deep learning MoE model."""
        if not tf:
            raise ImportError("TensorFlow is not installed. Please run 'pip install tensorflow' to use this model.")

        # --- 1. Data Preparation (Handles Univariate and Multivariate) ---
        target_series = train_data[[self.eda.sales_col]]

        if exog_train is not None:
            full_train_df = target_series.join(exog_train)
            feature_names = full_train_df.columns.tolist()
        else:
            full_train_df = target_series
            feature_names = [self.eda.sales_col]

        num_features = len(feature_names)

        scaler = MinMaxScaler(feature_range=(0, 1))
        scaled_data = scaler.fit_transform(full_train_df)

        INPUT_LEN = 30
        OUTPUT_LEN = 1

        if len(scaled_data) < INPUT_LEN + OUTPUT_LEN:
            raise ValueError(f"Not enough data for DL MoE model. Need {INPUT_LEN + OUTPUT_LEN} data points, have {len(scaled_data)}.")

        X_train, y_train = create_sequences(scaled_data, INPUT_LEN, OUTPUT_LEN)

        # --- 2. Model Training ---
        seasonal_period = {'D': 7, 'W': 52, 'M': 12, 'Q': 4, 'Y': 1}.get(self.eda.resample_freq, 7)
        moe_model = TimeSeriesMoE(input_len=INPUT_LEN, output_len=OUTPUT_LEN, num_features=num_features, period=seasonal_period, k=5)
        moe_model.compile(optimizer=Adam(learning_rate=0.001), loss='mae')

        moe_model.fit(
            X_train, y_train,
            epochs=30, batch_size=32, validation_split=0.2, verbose=0,
            callbacks=[tf.keras.callbacks.EarlyStopping(monitor='val_loss', patience=5, restore_best_weights=True)]
        )

        # --- 3. Forecasting ---
        forecast_scaled = []
        current_sequence = scaled_data[-INPUT_LEN:].reshape(1, INPUT_LEN, num_features)

        for i in range(n_periods):
            next_pred_scaled = moe_model.predict(current_sequence, verbose=0)
            forecast_scaled.append(next_pred_scaled[0, 0])

            # Prepare the next input step
            next_step_features_scaled = np.zeros((1, 1, num_features))
            next_step_features_scaled[0, 0, 0] = next_pred_scaled[0, 0] # Predicted target

            # If multivariate, add future exogenous features
            if num_features > 1 and exog_forecast is not None:
                future_exog_step = exog_forecast.iloc[[i]]
                # Scale exog features using the correct columns of the fitted scaler
                # --- FIX for scaler expecting DataFrame ---
                dummy_target = pd.DataFrame(np.zeros((len(future_exog_step), 1)), columns=[self.eda.sales_col], index=future_exog_step.index)
                future_step_full_df = pd.concat([dummy_target, future_exog_step], axis=1)
                scaled_future_exog = scaler.transform(future_step_full_df)[:, 1:]
                # --- END FIX ---
                next_step_features_scaled[0, 0, 1:] = scaled_future_exog

            # Slide the window forward
            current_sequence = np.append(current_sequence[:, 1:, :], next_step_features_scaled, axis=1)

        # --- 4. Inverse Transform and Finalize ---
        # Create a dummy array with the shape the scaler expects for inverse transform
        dummy_forecast_array = np.zeros((len(forecast_scaled), num_features))
        dummy_forecast_array[:, 0] = forecast_scaled
        forecast = scaler.inverse_transform(dummy_forecast_array)[:, 0]

        forecast_dates = pd.date_range(start=train_data.index[-1], periods=n_periods + 1, freq=self.eda.resample_freq)[1:]

        # In-sample predictions
        fitted_scaled = moe_model.predict(X_train, verbose=0)
        dummy_fitted_array = np.zeros((len(fitted_scaled), num_features))
        dummy_fitted_array[:, 0] = fitted_scaled.flatten()
        fitted = scaler.inverse_transform(dummy_fitted_array)[:, 0]

        padding = np.full(len(train_data) - len(fitted), np.nan)
        fitted_padded = np.concatenate([padding, fitted])

        return pd.Series(fitted_padded, index=train_data.index), pd.Series(forecast, index=forecast_dates), None, moe_model

    def _train_single_model(self, model_type, train_data, n_periods_forecast, exog_train, exog_forecast, use_tsfresh=False):
        model_map = {
            'auto_arima': self._forecast_auto_arima,
            'prophet': self._forecast_prophet,
            'exponential_smoothing': self._forecast_exponential_smoothing,
            'holt_winters': self._forecast_holt_winters,
            'dl_moe': self._forecast_dl_moe,
            'lightgbm': self._forecast_lightgbm,
            'arima': self._forecast_arima,      # <-- Included
            'sarimax': self._forecast_sarimax,  # <-- Included
        }

        # Pass 'use_tsfresh' only to the models that can use it.
        # Other models will ignore it thanks to **kwargs in their signatures.
        model_args = {'exog_train': exog_train, 'exog_forecast': exog_forecast, 'use_tsfresh': use_tsfresh}

        fitted, forecast, forecast_ci, components_or_model = model_map[model_type](train_data, n_periods_forecast, **model_args)

        components = None
        model_object = None
        if model_type == 'prophet':
            components, model_object = components_or_model
        else:
            model_object = components_or_model

        return fitted, forecast, forecast_ci, components, model_object

    def _evaluate_model_on_split(self, model_type, train_data, test_data, exog_train, exog_test, use_tsfresh=False, has_external_exog=False): # Added has_external_exog flag
        """Helper to train a model on a split, test it, and return all metrics."""
        try:
            n_periods_test = len(test_data) if test_data is not None else 0

            # --- FIX: Only pass exog if has_external_exog is True for ARIMA/SARIMAX ---
            pass_exog = exog_train is not None # Default: pass if available (covers internal features too for other models)
            if model_type == 'arima': # ARIMA never gets exog
                 pass_exog = False
            elif model_type == 'sarimax' and not has_external_exog: # SARIMAX only gets exog if external was provided
                 pass_exog = False

            current_exog_train = exog_train if pass_exog else None
            current_exog_test = exog_test if pass_exog else None
            # --- END FIX ---


            # Train model on the training set and forecast over the test set period
            fitted, forecast_on_test, _, components, model_object = self._train_single_model(
                model_type, train_data, n_periods_test,
                current_exog_train, current_exog_test, # Pass potentially None exog
                use_tsfresh
            )

            # --- Calculate In-Sample (Train) Metrics ---
            fitted_clean = fitted.dropna()
            # --- Robust alignment ---
            common_index = train_data.index.intersection(fitted_clean.index)
            train_data_aligned = train_data.loc[common_index, self.eda.sales_col]
            fitted_clean_aligned = fitted_clean.loc[common_index]
            # --- End robust alignment ---

            train_mape = self._calculate_mape(train_data_aligned, fitted_clean_aligned)
            train_mse = mean_squared_error(train_data_aligned, fitted_clean_aligned)
            train_rmse = np.sqrt(train_mse)

            # --- Calculate Out-of-Sample (Test) Metrics ---
            test_mape, test_rmse, test_mse = None, None, None
            if test_data is not None and not forecast_on_test.empty:
                 # --- Robust alignment for test ---
                common_test_index = test_data.index.intersection(forecast_on_test.index)
                test_data_aligned = test_data.loc[common_test_index, self.eda.sales_col]
                forecast_on_test_aligned = forecast_on_test.loc[common_test_index]
                 # --- End robust alignment ---
                if not forecast_on_test_aligned.empty: # Check if alignment resulted in empty series
                    test_mape = self._calculate_mape(test_data_aligned, forecast_on_test_aligned)
                    test_mse = mean_squared_error(test_data_aligned, forecast_on_test_aligned)
                    test_rmse = np.sqrt(test_mse)

            return {
                'model_name': model_type,
                'train_mape': train_mape, 'train_rmse': train_rmse, 'train_mse': train_mse,
                'test_mape': test_mape, 'test_rmse': test_rmse, 'test_mse': test_mse,
                'status': 'success',
                'components': components,
                'model_object': model_object # <-- Pass model object
            }
        except Exception as e:
            return {'model_name': model_type, 'status': 'failure', 'error': e}

    # --- FORECASTING METHOD WITH SINGLE TRAIN-TEST SPLIT ---
    def forecast(self, n_periods: int, models_to_try: list, error_threshold: float, new_product_strategy: str = 'proxy', use_tsfresh: bool = False):
        self.last_run_details = []

        if new_product_strategy == 'proxy' and self.proxy_files_data:
            self.eda = self._get_combined_eda()

        df_full_features = self.eda._engineer_features(use_tsfresh=use_tsfresh).set_index('date')
        full_train_data = self.eda.df_eda.copy()

        # --- FIX: Explicitly remove anomaly_score before any modeling ---
        if 'anomaly_score' in df_full_features.columns:
            df_full_features = df_full_features.drop(columns=['anomaly_score'])
        if 'anomaly_score' in full_train_data.columns:
            full_train_data = full_train_data.drop(columns=['anomaly_score'])

        # --- 1. TRAIN-TEST SPLIT ---
        test_size = n_periods
        if len(full_train_data) < test_size * 2:
            st.warning("Not enough data for a train-test split. Test metrics will not be calculated. Models will be compared on training performance only.")
            train_data, test_data = full_train_data, None
        else:
            train_data, test_data = full_train_data[:-test_size], full_train_data[-test_size:]

        # Prepare exogenous variables for the split and for the final forecast
        exog_cols = [col for col in df_full_features.columns if col != 'sales']
        exog_train_eval, exog_test_eval, exog_forecast_final, full_exog_train_final = None, None, None, None

        # --- Determine if we are *actually* using exogenous features (from user input) ---
        has_external_exog = 'exog_df' in st.session_state and st.session_state.exog_df is not None

        if exog_cols: # If *any* features were generated (internal or external)
            full_exog_train_all_features = df_full_features.loc[full_train_data.index, exog_cols]

            # --- Generate exog_forecast containing *only* generated features ---
            temp_eda = copy.deepcopy(self.eda)
            future_dates = pd.date_range(start=full_train_data.index[-1], periods=n_periods + 1, freq=self.eda.resample_freq)[1:]
            future_skeleton = pd.DataFrame(index=future_dates, columns=temp_eda.df_eda.columns)
            combined_df = pd.concat([temp_eda.df_eda, future_skeleton])
            temp_eda.df_eda = combined_df
            all_features_df = temp_eda._engineer_features(use_tsfresh=False).set_index('date')
            exog_forecast_all_features = all_features_df.loc[future_dates, exog_cols]
            self.exog_forecast = exog_forecast_all_features # Save for what-if

            # --- Conditionally assign exog variables based on user input ---
            if has_external_exog:
                # Use all generated features if external ones were provided
                full_exog_train_final = full_exog_train_all_features
                exog_forecast_final = exog_forecast_all_features
                if test_data is not None:
                    exog_train_eval = full_exog_train_final.loc[train_data.index]
                    exog_test_eval = full_exog_train_final.loc[test_data.index]
                else:
                    exog_train_eval = full_exog_train_final
            # else: Keep _eval and _final exog vars as None if no external file given

        # --- 2. MODEL EVALUATION LOOP (REVERTED TO PARALLEL) ---
        st.info("Evaluating models on a hold-out test set...")
        evaluation_results = []
        with st.spinner("Running model competition in parallel... (This may take a moment)"):
            with concurrent.futures.ThreadPoolExecutor() as executor:
                 # Pass potentially None exog variables to the evaluation function AND the has_external_exog flag
                futures = [executor.submit(self._evaluate_model_on_split, model, train_data, test_data, exog_train_eval, exog_test_eval, use_tsfresh, has_external_exog) for model in models_to_try]
                for future in concurrent.futures.as_completed(futures):
                    result = future.result()
                    if result['status'] == 'success':
                        evaluation_results.append(result)
                    else:
                         # Display warnings more prominently
                        st.warning(f"Could not run model {result['model_name'].upper()}. Error: {result['error']}")
                        # Also print for logs
                        print(f"Warning: Could not run model {result['model_name'].upper()}. Error: {result['error']}")


        if not evaluation_results: raise ValueError("No models trained successfully during evaluation.")

        # --- 3. POPULATE DETAILED RESULTS TABLE ---
        for res in evaluation_results:
            self.last_run_details.append({
                'Model': res['model_name'].upper(),
                'Train MAPE (%)': f"{res['train_mape']:.2f}", 'Train RMSE': f"{res['train_rmse']:.2f}",
                'Test MAPE (%)': f"{res['test_mape']:.2f}" if res['test_mape'] is not None else "N/A",
                'Test RMSE': f"{res['test_rmse']:.2f}" if res['test_rmse'] is not None else "N/A",
            })

        # --- 4. SELECT BEST MODEL & RETRAIN ON FULL DATA ---
        sort_key = 'test_mape' if test_data is not None else 'train_mape'
        sorted_models = sorted(evaluation_results, key=lambda x: x.get(sort_key) if x.get(sort_key) is not None else float('inf'))

        best_model_eval = sorted_models[0]
        best_model_name = best_model_eval['model_name']

        st.success(f"Best model from evaluation: **{best_model_name.upper()}** (based on {sort_key.replace('_', ' ').title()}). Now retraining on full historical data for final forecast.")

        try:
            with st.spinner(f"Retraining best model ({best_model_name.upper()}) and generating final forecast..."):
                 # --- FIX: Use correct exog vars for final training ---
                 pass_exog_final = full_exog_train_final is not None
                 if best_model_name == 'arima':
                     pass_exog_final = False
                 elif best_model_name == 'sarimax' and not has_external_exog:
                     pass_exog_final = False

                 current_full_exog_train = full_exog_train_final if pass_exog_final else None
                 current_exog_forecast = exog_forecast_final if pass_exog_final else None
                 # --- END FIX ---

                 final_fitted, final_forecast, final_ci, final_components, final_model_object = self._train_single_model(
                     best_model_name, full_train_data, n_periods,
                     current_full_exog_train, current_exog_forecast, # Use potentially None exog
                     use_tsfresh
                 )
        except Exception as e:
            raise ValueError(f"Failed to retrain the best model ({best_model_name.upper()}) on full data. Error: {e}")

        best_model_result = {
            'model_name': best_model_name, 'mape': best_model_eval.get(sort_key, 0),
            'fitted_values': final_fitted, 'forecast': final_forecast, 'forecast_ci': final_ci,
            'components': final_components, 'model_object': final_model_object # <-- Pass model object
        }

        # --- 5. ERROR CORRECTION (IF NEEDED) ---
        result_summary = {
            'Model': best_model_name.upper(),
            'Train MAPE (%)': f"{best_model_eval['train_mape']:.2f}",
            'Test MAPE (%)': f"{best_model_eval['test_mape']:.2f}" if best_model_eval['test_mape'] is not None else "N/A",
            'Error Correction Applied': False
        }

        final_forecast_output = final_forecast
        best_model_name_final = f"{best_model_name.upper()}" # Simpler name

        error_metric_to_check = best_model_eval['test_mape'] if test_data is not None else best_model_eval['train_mape']
        # --- Error correction only runs if external exog was actually provided ---
        if has_external_exog and full_exog_train_final is not None and error_metric_to_check is not None and error_metric_to_check > error_threshold and xgb:
            st.info("Base model test error is high. Applying advanced XGBoost error correction.")
            residuals = full_train_data[self.eda.sales_col] - final_fitted
            valid_residuals = residuals.dropna()

            if not valid_residuals.empty:
                result_summary['Error Correction Applied'] = True
                aligned_exog_train = full_exog_train_final.loc[valid_residuals.index]
                self.last_error_model = xgb.XGBRegressor(objective='reg:squarederror', n_estimators=200, random_state=42)
                self.last_X_train_columns = aligned_exog_train.columns
                self.last_error_model.fit(aligned_exog_train.values, valid_residuals.values)

                predicted_errors = self.last_error_model.predict(exog_forecast_final.reindex(columns=self.last_X_train_columns, fill_value=0).values)
                final_forecast_output += predicted_errors
                best_model_name_final = f"Corrected {best_model_name.upper()}"

        self.performance_results.append(result_summary)
        return final_forecast_output, best_model_name_final, best_model_result, result_summary


# =================================================================
# Helper Functions for Recommendations and Analysis
# =================================================================
@st.cache_data
def recommend_frequency(_df, date_col):
    """Recommends a forecasting frequency based on data span and density."""
    df = _df.copy()

    # Robustly convert to datetime, handling numeric (Excel), string, or existing datetime formats
    if pd.api.types.is_numeric_dtype(df[date_col]):
        df[date_col] = pd.to_datetime(df[date_col], origin='1899-12-30', unit='D')
    else:
        df[date_col] = pd.to_datetime(df[date_col], errors='coerce')

    df.dropna(subset=[date_col], inplace=True)
    if df.empty:
        raise ValueError("Date column could not be converted to a valid datetime format.")

    min_date = df[date_col].min()
    max_date = df[date_col].max()
    date_range_days = (max_date - min_date).days

    if date_range_days < 1:
        return 'D', "Data spans only a single day. Daily frequency is the only option.", 100.0

    total_days_in_span = date_range_days + 1
    unique_days_with_data = df[date_col].dt.date.nunique()
    density_percentage = (unique_days_with_data / total_days_in_span) * 100

    span_reason = f"Your data spans **{date_range_days} days** (from {min_date.strftime('%Y-%m-%d')} to {max_date.strftime('%Y-%m-%d')})."
    density_reason = f"Data is present for {unique_days_with_data} of these days, resulting in a data density of **{density_percentage:.0f}%**."

    if date_range_days > 365 * 2:
        freq_code = 'M'
        logic = "Given the long time span, a **Monthly** forecast is recommended to capture high-level trends."
    elif date_range_days > 90:
        if density_percentage < 65:
            freq_code = 'W'
            logic = "Due to the sparse nature of the daily data, aggregating to a **Weekly** level is recommended to create a more reliable and stable time series for forecasting."
        else:
            freq_code = 'W'
            logic = "A **Weekly** forecast is recommended to balance capturing seasonal patterns without being overly affected by daily noise."
    else:
        if density_percentage < 75:
             freq_code = 'W'
             logic = "While the data history is short, the daily data is too sparse for a reliable daily forecast. It's safer to aggregate to a **Weekly** level."
        else:
             freq_code = 'D'
             logic = "With a short but dense data history, a **Daily** forecast is recommended to leverage all available granular information."

    explanation = f"{span_reason}\n\n{density_reason}\n\n**Recommendation:** {logic}"
    return freq_code, explanation, density_percentage

@st.cache_data
def compare_frequencies(_df, date_col, sales_col):
    """
    Performs a head-to-head comparison of D, W, M, Y models using
    out-of-sample testing and AIC.
    """
    df_copy = _df.copy()
    df_copy[date_col] = pd.to_datetime(df_copy[date_col])
    df_copy = df_copy.set_index(date_col).sort_index()

    all_results = {}

    freq_params = {
        'D': {'min_len': 60, 'test_len': 30, 'seasonal_period': 7, 'name': 'Daily'},
        'W': {'min_len': 52, 'test_len': 8, 'seasonal_period': 52, 'name': 'Weekly'},
        'M': {'min_len': 24, 'test_len': 6, 'seasonal_period': 12, 'name': 'Monthly'},
        'Y': {'min_len': 4,  'test_len': 2, 'seasonal_period': 1, 'name': 'Yearly'}
    }

    for freq_code, params in freq_params.items():
        try:
            resampled_series = df_copy[sales_col].resample(freq_code).sum()

            if len(resampled_series) < params['min_len']:
                continue

            train_series = resampled_series.iloc[:-params['test_len']]
            test_series = resampled_series.iloc[-params['test_len']:]

            model = SARIMAX(train_series, order=(1,1,1), seasonal_order=(1,1,0, params['seasonal_period'])).fit(disp=False)

            forecast = model.forecast(steps=len(test_series))
            forecast.index = test_series.index

            mape = mean_absolute_percentage_error(test_series, forecast) * 100

            all_results[params['name']] = {'Test MAPE (%)': mape, 'AIC': model.aic}

        except Exception as e:
            all_results[params['name']] = {'Test MAPE (%)': float('inf'), 'AIC': float('inf'), 'Error': str(e)}

    if not all_results:
        return {"error": "Not enough data to perform a reliable comparison for any frequency."}

    return all_results

# --- NEW: NARRATIVE SUMMARY GENERATION (UPDATED) ---
def generate_narrative_summary(forecast_data: Dict, config: Dict) -> str:
    """Generates a human-readable summary of the forecast results."""

    best_model_name = forecast_data['best_model_name']
    best_model_result = forecast_data['best_model_result']
    result_summary = forecast_data['result']
    final_forecast = forecast_data['final_forecast']
    n_periods = len(final_forecast)
    freq_map = {'D': 'Daily', 'W': 'Weekly', 'M': 'Monthly', 'Q': 'Quarterly', 'Y': 'Yearly'}
    freq_name = freq_map.get(config['resample_freq'], 'periods')

    # Trend analysis
    x = np.arange(n_periods)
    y = final_forecast.values
    slope, intercept = np.polyfit(x, y, 1)
    trend_desc = "an upward trend" if slope > 0 else "a downward trend" if slope < 0 else "a stable trend"

    test_mape_str = result_summary.get('Test MAPE (%)', 'N/A')
    performance_metric = f"a Test MAPE of **{test_mape_str}%** on a hold-out dataset"
    if test_mape_str == 'N/A':
        train_mape_str = result_summary.get('Train MAPE (%)', 'N/A')
        performance_metric = f"a Train MAPE of **{train_mape_str}%** (no test set was used)"


    # Summary construction
    summary = f"""
    **Forecast Summary:**

    A forecast has been generated for the next **{n_periods} {freq_name} periods**.
    After a competition on a hold-out test set, the **{best_model_name.replace('_', ' ').title()}** model was selected as the most accurate predictor,
    achieving {performance_metric}.

    The forecast indicates **{trend_desc}** over the projection horizon.
    """

    if result_summary['Error Correction Applied']:
        summary += (
            "An advanced XGBoost model was used to correct for systematic errors in the baseline forecast, further enhancing accuracy. "
            "Feature importance analysis from this correction model can reveal key drivers of forecast uncertainty. "
        )

    if best_model_result.get('forecast_ci') is not None:
        summary += (
            "The accompanying plot displays probabilistic forecasts with confidence intervals, showing the range of most likely outcomes. "
        )

    return summary

# =================================================================
# Inventory and Demand Gap Analysis Functions
# =================================================================
def perform_demand_gap_analysis(forecast_df: pd.DataFrame, inventory_df: pd.DataFrame, inventory_col: str) -> pd.DataFrame:
    """Merges forecast with inventory and calculates the demand gap."""
    if not isinstance(inventory_df.index, pd.DatetimeIndex):
        inventory_df.set_index(pd.to_datetime(inventory_df.index), inplace=True)

    analysis_df = pd.merge(forecast_df, inventory_df[[inventory_col]], left_index=True, right_index=True, how='left').ffill()
    analysis_df.rename(columns={'Forecasted Values': 'forecast', 'forecast_values': 'forecast'}, inplace=True)

    analysis_df['demand_gap'] = analysis_df['forecast'] - analysis_df[inventory_col]
    analysis_df['demand_gap'] = analysis_df['demand_gap'].fillna(0)

    return analysis_df

def generate_inventory_insights_text(analysis_df: pd.DataFrame) -> Tuple[str, str]:
    """Generates textual explanations and recommendations as strings."""
    stockout_periods = analysis_df[analysis_df['demand_gap'] > 0]
    surplus_periods = analysis_df[analysis_df['demand_gap'] < 0]
    total_shortfall = stockout_periods['demand_gap'].sum()
    avg_surplus = -surplus_periods['demand_gap'].mean() if not surplus_periods.empty else 0
    num_stockout_periods = len(stockout_periods)

    stockout_text = ""
    surplus_text = ""

    if num_stockout_periods > 0:
        first_stockout_date = stockout_periods.index.min().strftime('%Y-%m-%d')
        stockout_text = (
            f"**Alert:** A potential stockout is first predicted on **{first_stockout_date}**. "
            f"The total demand may exceed inventory by **{total_shortfall:,.0f} units** over the forecast horizon.\n"
            "**Recommendations:**\n"
            "- **Review Purchase Orders:** Consider placing or expediting purchase orders to increase supply before the predicted shortfall date.\n"
            "- **Demand Shaping:** Evaluate options for promotions or marketing adjustments on alternative products to shift demand."
        )
    else:
        stockout_text = "**Good News:** No stockouts are predicted for the forecast horizon based on current inventory levels."

    if avg_surplus > 0:
        surplus_text = (
            f"**Notice:** On average, you are projected to have a surplus of **{avg_surplus:,.0f} units** during non-stockout periods.\n"
            "**Recommendations:**\n"
            "- **Inventory Optimization:** Review your reorder points and safety stock levels to potentially reduce holding costs.\n"
            "- **Sales & Marketing:** Consider running promotions to increase sales velocity for this product, especially if the surplus is significant."
        )
    return stockout_text, surplus_text

# =================================================================
# PDF Report Generation
# =================================================================
class PDF(FPDF):
    def __init__(self, *args, title="DhishaAI Time Lens Report", **kwargs):
        super().__init__(*args, **kwargs)
        self.report_title = title

    def header(self):
        self.set_font('Arial', 'B', 15)
        self.cell(0, 10, self.report_title, 0, 1, 'C')
        self.ln(5)

    def footer(self):
        self.set_y(-15)
        self.set_font('Arial', 'I', 8)
        self.cell(0, 10, f'Page {self.page_no()}', 0, 0, 'C')

    def chapter_title(self, title):
        self.set_font('Arial', 'B', 14)
        self.cell(0, 10, title, 0, 1, 'L')
        self.ln(4)

    def chapter_body(self, body):
        self.set_font('Arial', '', 12)
        self.multi_cell(0, 5, body)
        self.ln()

    def add_plot(self, plot_bytes):
        """Adds a plot from bytes, fitting it to the page width."""
        available_width = self.w - self.l_margin - self.r_margin
        img = io.BytesIO(plot_bytes)
        self.image(img, w=available_width)
        self.ln(5)

    def add_table_from_df(self, df: pd.DataFrame, title: str):
        self.chapter_title(title)

        # Header
        self.set_font('Arial', 'B', 10)
        self.set_fill_color(224, 235, 255)  # Light blue
        self.set_text_color(0)
        page_width = self.w - 2 * self.l_margin

        # Calculate optimal column widths
        col_widths = []
        for col in df.columns:
            # Simple heuristic: give more space to longer column names
            col_widths.append(len(col) * 3)

        # Normalize widths to fit the page
        total_width_ratio = sum(col_widths)
        col_widths = [(w / total_width_ratio) * page_width for w in col_widths]

        for i, header in enumerate(df.columns):
            self.cell(col_widths[i], 10, header, 1, 0, 'C', fill=True)
        self.ln()

        # Data rows with zebra striping
        self.set_font('Arial', '', 9)
        self.set_text_color(0)
        fill = False
        for index, row in df.iterrows():
            self.set_fill_color(245, 245, 245) # Light grey for striped rows
            for i, item in enumerate(row):
                if isinstance(item, (float, np.floating)):
                    item_str = f"{item:,.2f}"
                    align = 'R'
                else:
                    item_str = str(item)
                    align = 'L'
                self.cell(col_widths[i], 8, item_str, 'LR', 0, align, fill=fill)
            self.ln()
            fill = not fill

        # Bottom border line
        self.cell(sum(col_widths), 0, '', 'T')
        self.ln(10)

def generate_pdf_report(report_data: dict, config: dict) -> bytes:
    if not FPDF:
        st.error("The 'fpdf2' library is not installed. Please run 'pip install fpdf2' to enable PDF reporting.")
        return None

    pdf = PDF(title="DhishaAI Time Lens: Demand Forecast & Inventory Report")

    for group, data in report_data.items():
        pdf.add_page()
        pdf.chapter_title(f"Analysis for Group: {group}")

        # Section 1: All model performance summary
        pdf.add_table_from_df(data['perf_df'], "1. Model Competition Summary")

        # Section 2: Narrative Summary
        if 'narrative_summary' in data:
            pdf.chapter_title("2. Narrative Summary")
            pdf.chapter_body(data['narrative_summary'])

        # Section 3: Forecast Plot
        pdf.chapter_title("3. Forecast Plot")
        if data['forecast_plot']:
            pdf.add_plot(data['forecast_plot'])
        else:
            pdf.chapter_body("Could not generate forecast plot.")

        # Section 4: Inventory Analysis (if applicable)
        if data.get('inventory_plot'):
            if pdf.get_y() > 180: pdf.add_page()

            pdf.chapter_title("4. Demand Gap Analysis Plot")
            pdf.add_plot(data['inventory_plot'])

            pdf.chapter_title("5. Insights & Recommendations")
            pdf.chapter_body(data['stockout_text'])
            pdf.ln(3)
            pdf.chapter_body(data['surplus_text'])

            if data.get('analysis_df') is not None and not data['analysis_df'].empty:
                if pdf.get_y() > 200: pdf.add_page()

                report_df = data['analysis_df'].copy()
                report_df.index.name = 'Date'
                inv_col_name = data.get('inventory_val_col', 'inventory_on_hand')
                report_df.rename(columns={'forecast': 'Forecast', inv_col_name: 'Inventory', 'demand_gap': 'Demand Gap'}, inplace=True)
                report_df = report_df[['Forecast', 'Inventory', 'Demand Gap']].reset_index()

                freq = config.get('resample_freq', 'D')
                if freq in ['D', 'W']:
                    report_df['Date'] = report_df['Date'].dt.strftime('%Y-%m-%d')
                else:
                    report_df['Date'] = report_df['Date'].dt.strftime('%Y-%m')

                pdf.add_table_from_df(report_df.head(30), "6. Raw Calculation Data (First 30 Periods)")

        # Section 4: What-If Scenario (if applicable)
        if 'what_if_params' in data:
            if pdf.get_y() > 150: pdf.add_page()
            params = data['what_if_params']
            scenario_title = f"What-If Scenario: {params['percent']}% Growth, {params['constant']} Units Uplift"
            pdf.chapter_title(scenario_title)

            if data.get('what_if_plot'):
                pdf.add_plot(data.get('what_if_plot'))

            if data.get('what_if_insights'):
                stockout_text, surplus_text = data['what_if_insights']
                pdf.chapter_body(stockout_text)
                pdf.ln(3)
                pdf.chapter_body(surplus_text)

            if data.get('what_if_analysis_df') is not None and not data['what_if_analysis_df'].empty:
                if pdf.get_y() > 200: pdf.add_page()

                what_if_report_df = data['what_if_analysis_df'].copy()
                inv_col_name = data.get('inventory_val_col', 'inventory_on_hand')
                what_if_report_df.rename(columns={'forecast': 'Adj. Forecast', inv_col_name: 'Inventory', 'demand_gap': 'New Demand Gap'}, inplace=True)
                what_if_report_df = what_if_report_df[['Adj. Forecast', 'Inventory', 'New Demand Gap']].reset_index()
                what_if_report_df.rename(columns={'index': 'Date'}, inplace=True)

                freq = config.get('resample_freq', 'D')
                if freq in ['D', 'W']:
                    what_if_report_df['Date'] = what_if_report_df['Date'].dt.strftime('%Y-%m-%d')
                else:
                    what_if_report_df['Date'] = what_if_report_df['Date'].dt.strftime('%Y-%m')

                pdf.add_table_from_df(what_if_report_df.head(30), "Raw Scenario Calculation Data (First 30 Periods)")

    return bytes(pdf.output())

def generate_eda_pdf_report(group_name: str, report_data: dict) -> bytes:
    """Generates a dedicated PDF report for the Exploratory Data Analysis."""
    if not FPDF:
        st.error("The 'fpdf2' library is not installed. Please run 'pip install fpdf2' to enable PDF reporting.")
        return None

    pdf = PDF(title="DhishaAI Time Lens: Exploratory Data Analysis Report")
    pdf.add_page()
    pdf.chapter_title(f"Exploratory Data Analysis for Group: {group_name}")

    # Section 1: Data Quality Summary
    if 'summary_metrics' in report_data:
        summary_df = pd.DataFrame(list(report_data['summary_metrics'].items()), columns=['Metric', 'Value'])
        pdf.add_table_from_df(summary_df, "1. Data Quality & Summary")

    # Section 2: Add all the plots
    plot_titles = {
        'distribution_plot': "2. Target Variable Distribution",
        'trend_plot': "3. Trend Over Time",
        'decomposition_plot': "4. Time Series Decomposition",
        'anomaly_plot': "5. Anomaly Detection",
        'correlation_plot': "6. Feature Correlation Heatmap",
        'acf_pacf_plot': "7. ACF & PACF Plots",
        'holiday_plot': "8. Holiday Analysis"
    }

    for key, title in plot_titles.items():
        if report_data.get(key) and report_data[key] is not None:
            try:
                if pdf.get_y() > 180: # Check if there is enough space, add new page if not
                    pdf.add_page()
                pdf.chapter_title(title)
                pdf.add_plot(report_data[key])
            except Exception as e:
                st.warning(f"Could not add plot '{title}' to PDF report. Error: {e}")

    return bytes(pdf.output())

# =================================================================
# HELPER FUNCTION FOR ATTRIBUTION (UPDATED)
# =================================================================
def generate_attribution_df(forecast_data: Dict[str, Any], config: Dict[str, Any]) -> pd.DataFrame:
    """
    Decomposes the forecast and prepares a DataFrame for hover attribution,
    specifically isolating individual exogenous features for Prophet models where possible.
    """
    final_forecast_series = forecast_data['final_forecast']
    best_model_result = forecast_data['best_model_result']
    is_corrected = forecast_data['result']['Error Correction Applied']

    clean_attribution_df = pd.DataFrame(index=final_forecast_series.index)

    # --- Path A: Prophet Model ---
    if best_model_result['model_name'] == 'prophet' and best_model_result.get('components') is not None:
        prophet_components = best_model_result['components'].set_index('ds')
        prophet_components = prophet_components.reindex(final_forecast_series.index, fill_value=0)

        # 1. Explicitly select core components
        clean_attribution_df['Trend'] = prophet_components['trend']

        seasonal_cols = [col for col in prophet_components.columns if 'seasonal' in col or col in ['weekly', 'yearly', 'daily']]
        clean_attribution_df['Seasonal'] = prophet_components[seasonal_cols].sum(axis=1)

        # 2. Use a stricter filter to identify only true exogenous regressors
        prophet_internal_cols = ['trend', 'yhat', 'multiplicative_terms', 'additive_terms'] + seasonal_cols
        cols_to_exclude = [col for col in prophet_components.columns if col.endswith(('_lower', '_upper')) or col in prophet_internal_cols]
        exog_cols = [col for col in prophet_components.columns if col not in cols_to_exclude]

        for col in exog_cols:
            if col in prophet_components:
                clean_attribution_df[col] = prophet_components[col]

        # 3. Add error correction as its own component if applicable
        if is_corrected:
            base_forecast = best_model_result['forecast']
            error_correction = final_forecast_series - base_forecast
            clean_attribution_df['Error_Correction'] = error_correction

    # --- Path B: All Other Models ---
    else:
        periods = {'D': 7, 'W': 4, 'M': 12, 'Q': 4, 'Y': 2}
        period = periods.get(config['resample_freq'], 4)

        if len(final_forecast_series) > period * 2:
            decomp = seasonal_decompose(final_forecast_series.fillna(0), model='additive', period=period)
            clean_attribution_df['Trend'] = decomp.trend
            clean_attribution_df['Seasonal'] = decomp.seasonal
            clean_attribution_df['Residual/Other'] = decomp.resid
        else:
            clean_attribution_df['Trend'] = final_forecast_series

    # --- Finalize and Calculate Percentages on the clean dataframe ---
    clean_attribution_df.fillna(0, inplace=True)

    total_abs_sum = clean_attribution_df.abs().sum(axis=1)
    total_abs_sum[total_abs_sum == 0] = 1 # Avoid division by zero

    for col in clean_attribution_df.columns:
        if not col.endswith('_pct'):
            clean_attribution_df[f'{col}_pct'] = (clean_attribution_df[col].abs() / total_abs_sum) * 100

    return clean_attribution_df

# --- NEW HELPER FUNCTION FOR CAUSAL ANALYSIS ---
# <-- MODIFICATION: Replaced with multi-treatment version -->
def build_causal_graph(treatments: List[str], outcome: str, confounders: List[str]) -> str:
    """Generates a DOT string for a causal graph to be used with graphviz."""
    if not graphviz:
        return ""
    dot = graphviz.Digraph()
    dot.attr('node', shape='box', style='rounded')

    # Use a singular name if only one treatment
    if len(treatments) == 1:
        dot.node(treatments[0], treatments[0], color='orange', style='filled, rounded')
    else:
        for t in treatments:
            dot.node(t, t, color='orange', style='filled, rounded')

    dot.node(outcome, outcome, color='lightblue', style='filled, rounded')
    for c in confounders:
        dot.node(c, c)

    for t in treatments:
        dot.edge(t, outcome)
        for c in confounders:
            dot.edge(c, t)

    # Edges from confounders to outcome
    for c in confounders:
        dot.edge(c, outcome)

    return dot.source

# =================================================================
# Streamlit App Main Function
# =================================================================

def main():
    st.set_page_config(page_title="DhishaAI Time Lens", page_icon="dhishaai logo.jpg", layout="wide")

    # --- MODIFICATION START: Inject CSS for DhishaAI branding ---
    DHISHAAI_BLUE = "#073e5c"
    DHISHAAI_ORANGE = "#ef7602"

    st.markdown(f"""
        <style>
            /* General layout adjustments */
            .block-container {{
                padding-top: 2rem;
            }}

            /* Change Streamlit's primary color to DhishaAI Orange */
            :root {{
                --primary-color: {DHISHAAI_ORANGE};
                --text-color: {DHISHAAI_BLUE};
            }}

            /* Set all headers to DhishaAI Blue */
            h1, h2, h3, h4, h5, h6 {{
                color: {DHISHAAI_BLUE};
            }}

            /* Style buttons with brand colors */
            .stButton > button {{
                border-color: {DHISHAAI_ORANGE};
                background-color: {DHISHAAI_ORANGE};
                color: white;
            }}
            .stButton > button:hover {{
                border-color: {DHISHAAI_BLUE};
                background-color: {DHISHAAI_BLUE};
                color: white;
            }}
            .stButton > button:focus {{
                box-shadow: 0 0 0 0.2rem rgba(239, 118, 2, 0.5) !important;
            }}

            /* Style the active tab with an orange underline */
            .stTabs [data-baseweb="tab"][aria-selected="true"] {{
                background-color: transparent;
                border-bottom: 3px solid {DHISHAAI_ORANGE};
                color: {DHISHAAI_ORANGE};
            }}

            /* Style expander headers */
            .st-expander-header {{
                font-size: 1.1rem;
                font-weight: 600;
                color: {DHISHAAI_BLUE};
            }}

        </style>
        """, unsafe_allow_html=True)

    # Custom styled title
    st.markdown(f"""
        <h1 style='text-align: left;'>
            Dhisha<span style='color: {DHISHAAI_ORANGE};'>AI</span> Time Lens
        </h1>
        """, unsafe_allow_html=True)
    # --- MODIFICATION END ---

    st.markdown("Your complete end-to-end solution for demand forecasting. Go from raw data to actionable insights and downloadable reports in minutes.")

    with st.expander("About this Tool: Architecture & Advantages", expanded=False):
        st.subheader("High-Level Architecture")
        st.markdown("""
        This application is built on a modular, object-oriented architecture designed for clarity and scalability. It consists of three main components:
        1.  **The Streamlit UI (`main` function):** The user-facing dashboard that handles all inputs, controls the application flow, and visualizes results.
        2.  **The Analyst (`TimeSeriesEDA` Class):** The data processing engine. It takes raw data and performs cleaning, **interactive anomaly detection**, feature engineering, and generates all analytical visualizations.
        3.  **The Predictor (`TimeSeriesForecaster` Class):** The forecasting engine. It orchestrates a competition between multiple models (**including ARIMA, SARIMAX, AutoARIMA and LightGBM**) using a hold-out test set, selects the best one, and applies an advanced error-correction mechanism.
        4.  **The Inquisitor (`DoWhy` Integration):** The causal inference engine. It allows users to go beyond correlation and ask "what if" questions to understand the true drivers of their sales.
        """)

        st.subheader("Key Advantages")
        st.markdown("""
        * **Automation & Speed:** Automates critical steps like data cleaning and feature engineering. Model training is parallelized for faster results.
        * **State-of-the-Art Model Arsenal:** Competes multiple models from classical statistics (ARIMA, SARIMAX, AutoARIMA) to machine learning (LightGBM, XGBoost) and deep learning (Mixture of Experts) to find the best fit for your data.
        * **Probabilistic Forecasting:** Generates **confidence intervals** to quantify forecast uncertainty, moving beyond simple point estimates.
        * **Interactive & Editable EDA:** The dashboard is now customizable, and you have full control to **review and edit** the results of the automated anomaly detection.
        * **Automated Insights:** Generates **narrative summaries** of forecast results, making complex outputs easy to understand.
        * **Causal Explainability:** Uncover true cause-and-effect relationships in your data, powered by the `DoWhy` library.
        * **Integrated Inventory Analysis:** Go beyond the forecast by analyzing its impact on inventory, identifying potential stockouts or surplus situations.
        """)

    if 'initialized' not in st.session_state:
        st.session_state.initialized = False
        st.session_state.ran_forecast = False
        st.session_state.comparison_results = None
        st.session_state.df = None
        st.session_state.inventory_df = None
        st.session_state.exog_df = None
        st.session_state.eda_objects = {}
        st.session_state.all_forecast_results = {}
        st.session_state.report_data = {}
        st.session_state.groups_to_display_for_what_if = []
        # Add session state for causal analysis
        st.session_state.causal_model = None
        st.session_state.causal_estimate = None
        st.session_state.causal_refutation = None
        st.session_state.causal_variables = {}
        st.session_state.causal_group = None
        # Add session state for editable anomalies
        st.session_state.edited_anomalies_df = None
        # <-- MODIFICATION: Added state for what-if scenarios -->
        st.session_state.what_if_scenario_rules = []


    with st.sidebar:
        st.image("dhishaai logo.jpg", use_column_width=True)

        data_input_expanded = not st.session_state.get('data_loaded', False)
        with st.expander("1. Data Input", expanded=data_input_expanded):
            st.subheader("Sales Data Source")
            sales_source = st.radio("Select source", ["Upload CSV", "MySQL Database"], key="sales_src", horizontal=True)

            st.subheader("Inventory Data Source")
            inventory_source = st.radio("Select source", ["None", "Upload CSV", "MySQL Database"], key="inv_src", horizontal=True)

            st.subheader("External Factors Source")
            exog_source = st.radio("Select source", ["None", "Upload CSV", "MySQL Database"], key="exog_src", horizontal=True)

            is_mysql_used = any(src == "MySQL Database" for src in [sales_source, inventory_source, exog_source])
            db_host, db_user, db_password, db_name = None, None, None, None
            sales_query, inventory_query, exog_query = "", "", ""

            if is_mysql_used:
                st.markdown("---")
                st.subheader("Database Credentials")
                db_host = st.text_input("Host", "localhost")
                db_user = st.text_input("User", "root")
                db_password = st.text_input("Password", type="password")
                db_name = st.text_input("Database Name")
                st.markdown("---")

            uploaded_file, inventory_file, exog_file = None, None, None

            if sales_source == "Upload CSV":
                uploaded_file = st.file_uploader("Upload your sales time series CSV", type="csv")
            elif sales_source == "MySQL Database":
                sales_query = st.text_area("SQL Query for Sales Data", "SELECT date, product, sales FROM your_sales_table;")

            if inventory_source == "Upload CSV":
                inventory_file = st.file_uploader("Upload Inventory Data CSV", type="csv")
            elif inventory_source == "MySQL Database":
                inventory_query = st.text_area("SQL Query for Inventory Data", "SELECT date, product, inventory_on_hand FROM your_inventory_table;")

            if exog_source == "Upload CSV":
                exog_file = st.file_uploader("Upload External Factors CSV", type="csv", help="This file must contain future values for the forecast period.")
            elif exog_source == "MySQL Database":
                exog_query = st.text_area("SQL Query for External Factors", "SELECT date, marketing_spend, active_promotion FROM your_factors_table;")

            st.markdown("---")

            if st.button("Load & Process Data", use_container_width=True):
                with st.spinner("Loading data from specified sources..."):
                    if sales_source == "Upload CSV" and uploaded_file:
                        st.session_state.df = pd.read_csv(uploaded_file)
                    elif sales_source == "MySQL Database":
                        st.session_state.df = load_data_from_mysql(db_host, db_user, db_password, db_name, sales_query)

                    if inventory_source == "Upload CSV" and inventory_file:
                        st.session_state.inventory_df = pd.read_csv(inventory_file)
                    elif inventory_source == "MySQL Database":
                        st.session_state.inventory_df = load_data_from_mysql(db_host, db_user, db_password, db_name, inventory_query)
                    else:
                        st.session_state.inventory_df = None

                    if exog_source == "Upload CSV" and exog_file:
                        st.session_state.exog_file_df = pd.read_csv(exog_file)
                    elif exog_source == "MySQL Database":
                        st.session_state.exog_file_df = load_data_from_mysql(db_host, db_user, db_password, db_name, exog_query)
                    else:
                        st.session_state.exog_file_df = None

                    st.success("Data loading complete.")
                    st.session_state.data_loaded = True
                    st.rerun()

        if st.session_state.get('data_loaded', False):
            config_expanded = not st.session_state.get('initialized', False)
            with st.expander("2. Configuration & Initialization", expanded=config_expanded):
                df = st.session_state.df
                inventory_df = st.session_state.inventory_df
                exog_df_uploaded = st.session_state.get('exog_file_df')

                st.subheader("Column Configuration")
                st.markdown("###### Sales Data")
                date_col = st.selectbox("Select Date Column", df.columns, index=0)
                # --- NEW: Date Format Selection ---
                date_format_options = {
                    "Auto-detect": None,
                     "DD-MM-YYYY": "%d-%m-%Y",
                     "MM-DD-YYYY": "%m-%d-%Y",
                     "YYYY-MM-DD": "%Y-%m-%d",
                     "DD/MM/YYYY": "%d/%m/%Y",
                     "MM/DD/YYYY": "%m/%d/%Y",
                     "DD-MMM-YY (e.g. 01-Jan-22)": "%d-%b-%y"
                    }
                selected_date_format_label = st.selectbox(
                 "Select Date Format (Optional)", 
                options=list(date_format_options.keys()),
                 help="Explicitly setting the format prevents errors if your CSV uses non-standard date layouts."
                    )
                date_format_string = date_format_options[selected_date_format_label]
                sales_col = st.selectbox("Select Sales/Value Column", df.columns, index=min(2, len(df.columns)-1))

                selected_groups = []
                group_cols = []
                group_col_for_logic = None
                cat_col_options = [col for col in df.columns if col not in [date_col, sales_col]]

                if cat_col_options:
                    group_cols = st.multiselect("Select Grouping Column(s) (e.g., Store, Item)", cat_col_options)

                    df_ui_copy = df.copy()

                    if group_cols:
                        if len(group_cols) > 1:
                            df_ui_copy['composite_group'] = df_ui_copy[group_cols].astype(str).agg('_'.join, axis=1)
                            group_col_for_logic = 'composite_group'
                        else:
                            group_col_for_logic = group_cols[0]

                        unique_groups = sorted(list(df_ui_copy[group_col_for_logic].unique()))

                        select_all = st.checkbox(f"Select All {len(unique_groups)} combinations")

                        default_selection = []
                        if select_all:
                            default_selection = unique_groups
                        elif unique_groups:
                            default_selection = [unique_groups[0]]

                        selected_groups = st.multiselect(f"Select which group(s) to forecast", unique_groups, default=default_selection)

                inventory_date_col, inventory_val_col = None, None
                if inventory_df is not None:
                    st.markdown("###### Inventory Data")
                    inventory_df.dropna(how='all', inplace=True)
                    inventory_date_col = st.selectbox("Select Inventory Date Column", inventory_df.columns, index=0)
                    inventory_val_col = st.selectbox("Select Inventory On-Hand Column", inventory_df.columns, index=min(2, len(inventory_df.columns)-1))

                exog_date_col, exog_feature_cols, exog_agg_method = None, None, 'sum'
                if exog_df_uploaded is not None:
                    st.markdown("###### External Factors Data")
                    exog_date_col = st.selectbox("Select Date Column (External Data)", exog_df_uploaded.columns, index=0)
                    exog_num_cols = exog_df_uploaded.select_dtypes(include=np.number).columns.tolist()
                    exog_feature_cols = st.multiselect("Select Feature Columns to Use", exog_num_cols, default=exog_num_cols[0] if exog_num_cols else None)
                    exog_agg_method = st.selectbox("Resampling Method for Features", ["sum", "mean"])

                country_code = st.text_input("Enter Country Code for Holidays", "US")

                st.subheader("Forecast Level")
                freq_map = {'D': 'Daily', 'W': 'Weekly', 'M': 'Monthly', 'Q': 'Quarterly', 'Y': 'Yearly'}
                reverse_freq_map = {v: k for k, v in freq_map.items()}

                # Filter data based on user's group selection before recommending frequency
                df_for_recommendation = df_ui_copy.copy() # Default to the full dataset
                if group_col_for_logic and selected_groups:
                    # If groups are selected, filter the dataframe to only include those groups
                    df_for_recommendation = df_ui_copy[df_ui_copy[group_col_for_logic].isin(selected_groups)]

                try:
                    # Use the filtered dataframe for the recommendation
                    recommended_freq_code, recommendation_explanation, density_percentage = recommend_frequency(df_for_recommendation, date_col)
                    st.session_state.data_density = density_percentage

                    recommended_freq_name = freq_map[recommended_freq_code]

                    st.info(f"Recommended Frequency: **{recommended_freq_name}**")
                    st.markdown(recommendation_explanation) # Display explanation directly

                    rec_index = list(reverse_freq_map.keys()).index(recommended_freq_name)
                except Exception as e:
                    st.error(f"Could not recommend frequency. Defaulting to Daily. Error: {e}")
                    rec_index = 0

                analysis_target = "Overall (All Selected Groups)"
                if selected_groups:
                    options = ["Overall (All Selected Groups)"] + selected_groups
                    analysis_target = st.selectbox(
                        "Select a group for Frequency Performance Analysis",
                        options
                    )

                if st.button("Run Frequency Performance Analysis", use_container_width=True):
                    with st.spinner(f"Running head-to-head model comparison for '{analysis_target}'..."):
                        # Start with the dataframe that is already filtered by the multiselect
                        df_for_comparison = df_for_recommendation.copy()

                        # If a specific group is chosen from the new dropdown, filter further
                        if analysis_target != "Overall (All Selected Groups)":
                            df_for_comparison = df_for_comparison[df_for_comparison[group_col_for_logic] == analysis_target]

                        st.session_state.comparison_results = compare_frequencies(df_for_comparison, date_col, sales_col)

                if st.session_state.comparison_results:
                    results = st.session_state.comparison_results
                    if "error" in results:
                        st.error(results["error"])
                    else:
                        st.subheader("Statistical Comparison Results")
                        results_df = pd.DataFrame.from_dict(results, orient='index').sort_values('Test MAPE (%)')
                        st.dataframe(results_df.style.format({'Test MAPE (%)': '{:.2f}','AIC': '{:.2f}'}))

                        best_mape = results_df['Test MAPE (%)'].idxmin()
                        best_aic = results_df['AIC'].idxmin()

                        density = st.session_state.get('data_density')
                        density_info = f" (Data Density: **{density:.0f}%**)" if density is not None else ""

                        st.markdown("---")
                        if best_mape == best_aic:
                            decision_text = f"**Winner: {best_mape}** is statistically the best option.{density_info}"
                            st.success(decision_text)
                        else:
                            decision_text = f"**Split Decision:** **{best_mape}** is best for forecast accuracy (MAPE), while **{best_aic}** is the most efficient model (AIC).{density_info}"
                            st.info(decision_text)

                        caption_text = "Lower MAPE & AIC are better. This analysis uses a test set. A low data density can make granular forecasts (like Daily) unreliable, even with a good test score."
                        st.caption(caption_text)

                frequency_name = st.selectbox("Select Forecast Frequency (Override)", options=list(reverse_freq_map.keys()), index=rec_index)
                resample_freq = reverse_freq_map[frequency_name]

                st.subheader("Advanced Settings")
                contamination_pct = st.slider("Anomaly Sensitivity (%)", min_value=1.0, max_value=25.0, value=5.0, step=0.5, help="Higher values will detect more anomalies. This is the expected percentage of outliers in the data.")
                contamination = contamination_pct / 100.0

                new_product_threshold = st.number_input("New Product Threshold (days)", min_value=1, value=180, help="Data with a history shorter than this will trigger the new product forecasting strategy.")

                proxy_files = None
                use_internal_proxies = True

                temp_df = df.copy()
                temp_df[date_col] = pd.to_datetime(temp_df[date_col])

                show_new_product_ui = False
                groups_to_check = selected_groups if (group_col_for_logic and selected_groups) else ["Overall"]

                df_for_new_product_check = df_ui_copy if group_col_for_logic == 'composite_group' else temp_df

                if group_cols and not selected_groups:
                     pass
                else:
                    for group in groups_to_check:
                        if group == "Overall":
                            product_df = df_for_new_product_check
                        else:
                            product_df = df_for_new_product_check[df_for_new_product_check[group_col_for_logic] == group]

                        if not product_df.empty and len(product_df) > 1:
                            # Convert date column for calculation if it hasn't been already
                            if not pd.api.types.is_datetime64_any_dtype(product_df[date_col]):
                                product_df[date_col] = pd.to_datetime(product_df[date_col])

                            date_range_days = (product_df[date_col].max() - product_df[date_col].min()).days
                            if date_range_days < new_product_threshold:
                                show_new_product_ui = True
                                break

                if show_new_product_ui:
                    st.info("A short data history was detected for at least one selected product.")
                    st.subheader("New Product Scenario")
                    use_internal_proxies = st.checkbox("Automatically use other products from the main file as proxies", value=True)
                    proxy_files = st.file_uploader("Upload optional external proxy CSVs", type="csv", accept_multiple_files=True, help="Use this to add proxies not present in your main dataset.")

                if st.button("Initialize & Run EDA", use_container_width=True):
                    if group_cols and not selected_groups:
                        st.warning(f"Please select at least one group combination to proceed.")
                    else:
                        with st.spinner("Processing data for selected groups..."):
                            try:
                                # Clear previous causal analysis state
                                st.session_state.causal_model = None
                                st.session_state.causal_estimate = None
                                # <-- MODIFICATION: Clear what-if scenario on re-init -->
                                st.session_state.what_if_scenario_rules = []

                                df_processed = df.copy()
                                final_group_col = None
                                if group_cols:
                                    if len(group_cols) > 1:
                                        df_processed['composite_group'] = df_processed[group_cols].astype(str).agg('_'.join, axis=1)
                                        final_group_col = 'composite_group'
                                    else:
                                        final_group_col = group_cols[0]

                                if exog_df_uploaded is not None and exog_date_col and exog_feature_cols:
                                    exog_df = exog_df_uploaded.copy()
                                    exog_df[exog_date_col] = pd.to_datetime(exog_df[exog_date_col])
                                    exog_df = exog_df.set_index(exog_date_col)[exog_feature_cols]
                                    exog_df = exog_df.resample(resample_freq).agg(exog_agg_method)
                                    st.session_state.exog_df = exog_df.ffill().bfill()
                                    st.success("External factors data processed.")
                                else:
                                    st.session_state.exog_df = None

                                st.session_state.eda_objects = {}
                                groups_to_process = selected_groups if selected_groups else ["Overall"]

                                for group in groups_to_process:
                                    if group == "Overall":
                                        product_df = df_processed
                                    else:
                                        product_df = df_processed[df_processed[final_group_col] == group].copy()

                                    eda = TimeSeriesEDA(product_df, date_col, sales_col, country_code, contamination=contamination, resample_freq=resample_freq)
                                    st.session_state.eda_objects[group] = eda

                                st.session_state.config = {
                                    'date_col': date_col, 'sales_col': sales_col, 'group_cols': group_cols,
                                    'group_col_logic': final_group_col,
                                    'country_code': country_code, 'contamination': contamination,
                                    'resample_freq': resample_freq, 'selected_groups': groups_to_process,
                                    'proxy_files': proxy_files,
                                    'use_internal_proxies': use_internal_proxies,
                                    'new_product_threshold': new_product_threshold,
                                    'inventory_date_col': inventory_date_col, 'inventory_val_col': inventory_val_col
                                }

                                st.session_state.initialized = True
                                st.session_state.ran_forecast = False

                                newly_identified_products = []
                                existing_products = []
                                threshold = st.session_state.config['new_product_threshold']

                                for group_name, eda_object in st.session_state.eda_objects.items():
                                    if len(eda_object.df_prepared.index) > 1:
                                        date_range_days = (eda_object.df_prepared.index.max() - eda_object.df_prepared.index.min()).days
                                        if date_range_days < threshold:
                                            newly_identified_products.append(group_name)
                                        else:
                                            existing_products.append(group_name)
                                    else:
                                        newly_identified_products.append(group_name)

                                success_message = "**Initialization Complete!** The EDA tab is now populated. Please review and apply anomaly corrections before forecasting."
                                if newly_identified_products:
                                    success_message += f"\n\n- **New Products Identified:** `{', '.join(map(str, newly_identified_products))}`. The proxy-based strategy will be used for these items during forecasting."
                                if existing_products:
                                    success_message += f"\n\n- **Existing Products Identified:** `{', '.join(map(str, existing_products))}`. A standard forecast will be run for these items."

                                st.success(success_message)
                                st.rerun()

                            except Exception as e:
                                st.error(f"An error occurred during initialization: {e}")
                                st.exception(e)

    if not st.session_state.get('data_loaded'):
        st.info("Welcome! Please select your data sources in the sidebar and click 'Load & Process Data' to begin.")

    elif not st.session_state.get('initialized'):
        st.info("Data has been loaded. Please configure your settings in the sidebar, then click 'Initialize & Run EDA'.")

    else:
        # <-- MODIFICATION: Added 4th tab -->
        tabs = ["Exploratory Data Analysis", "Forecast & Performance", "Causal Explainability", "🔬 What-If Scenarios"]
        tab1, tab2, tab3, tab4 = st.tabs(tabs)

        with tab1:
            st.header("Exploratory Data Analysis")

            selected_groups_for_eda = st.session_state.config['selected_groups']
            if len(selected_groups_for_eda) > 1:
                group_to_display = st.selectbox("Select a group to view its EDA", selected_groups_for_eda)
            else:
                group_to_display = selected_groups_for_eda[0]

            eda_to_display = st.session_state.eda_objects[group_to_display]

            # --- NEW: Customizable Dashboard ---
            st.markdown("---")
            all_plots = ["Data Quality & Distribution", "Trend Analysis", "Time Series Decomposition",
                         "Anomaly Detection", "Correlation Heatmap", "ACF/PACF Plots", "Holiday Analysis"]
            plots_to_show = st.multiselect("Select analyses to display:", options=all_plots, default=all_plots)
            st.markdown("---")

            eda_report_content = {}

            # --- NEW: Editable Anomaly Detection Section ---
            with st.expander("Interactive Anomaly Review & Correction", expanded=True):
                st.info("An Isolation Forest model has identified the points below as potential anomalies. Review the suggestions and uncheck any points you believe are legitimate data, not anomalies.")

                if not eda_to_display.potential_anomalies_df.empty:
                    st.session_state.edited_anomalies_df = st.data_editor(
                        eda_to_display.potential_anomalies_df,
                        column_config={"Correct Anomaly": st.column_config.CheckboxColumn(default=True)},
                        disabled=["Date", "Value", "Is Holiday", "Suggested Action"],
                        key=f"editor_{group_to_display}"
                    )

                    if st.button(f"Apply Anomaly Corrections for {group_to_display}", use_container_width=True):
                        with st.spinner("Applying corrections..."):
                            eda_to_display.apply_anomaly_corrections(st.session_state.edited_anomalies_df)
                            st.rerun() # Rerun to update plots with cleaned data
                else:
                    st.success("No significant anomalies were detected in the data.")

            # --- EDA Plots (now conditional) ---
            if "Data Quality & Distribution" in plots_to_show:
                with st.expander("Data Quality & Distribution", expanded=True):
                    fig, metrics = eda_to_display.display_data_summary_and_distribution()
                    if fig:
                        fig.update_layout(template="plotly_white")
                        eda_report_content['distribution_plot'] = fig.to_image(format="png", scale=2)
                    eda_report_content['summary_metrics'] = metrics

            if "Trend Analysis" in plots_to_show:
                with st.expander("Trend Analysis"):
                    fig = eda_to_display.plot_trend()
                    if fig:
                        fig.update_layout(template="plotly_white")
                        eda_report_content['trend_plot'] = fig.to_image(format="png", scale=2)

            if "Time Series Decomposition" in plots_to_show:
                with st.expander("Time Series Decomposition"):
                    fig = eda_to_display.plot_decomposition()
                    if fig:
                        fig.update_layout(template="plotly_white")
                        eda_report_content['decomposition_plot'] = fig.to_image(format="png", scale=2)

            if "Anomaly Detection" in plots_to_show:
                with st.expander("Anomaly Detection"):
                    fig = eda_to_display.plot_anomaly_detection()
                    if fig:
                        fig.update_layout(template="plotly_white")
                        eda_report_content['anomaly_plot'] = fig.to_image(format="png", scale=2)

            if "Correlation Heatmap" in plots_to_show:
                with st.expander("Correlation Heatmap"):
                    fig = eda_to_display.plot_correlation_heatmap()
                    if fig:
                        fig.update_layout(template="plotly_white")
                        eda_report_content['correlation_plot'] = fig.to_image(format="png", scale=2)

            if "ACF/PACF Plots" in plots_to_show:
                with st.expander("ACF/PACF Plots"):
                    fig = eda_to_display.plot_acf_pacf()
                    if fig:
                        fig.update_layout(template="plotly_white")
                        eda_report_content['acf_pacf_plot'] = fig.to_image(format="png", scale=2)

            if "Holiday Analysis" in plots_to_show:
                with st.expander("Holiday Analysis"):
                    fig = eda_to_display.analyze_holidays()
                    if fig:
                        fig.update_layout(template="plotly_white")
                        eda_report_content['holiday_plot'] = fig.to_image(format="png", scale=2)

            # --- EDA Export Center ---
            st.markdown("---")
            st.header("EDA Export Center")
            pdf_eda_bytes = generate_eda_pdf_report(group_to_display, eda_report_content)
            if pdf_eda_bytes:
                st.download_button(
                    label="Download EDA Report as PDF",
                    data=pdf_eda_bytes,
                    file_name=f"EDA_Report_{str(group_to_display).replace(' ', '_')}.pdf",
                    mime="application/pdf",
                    use_container_width=True
                )

        with tab2:
            st.header("Forecasting Controls")
            freq_map = {'D': 'Daily', 'W': 'Weekly', 'M': 'Monthly', 'Q': 'Quarterly', 'Y': 'Yearly'}
            freq_name = freq_map[st.session_state.config['resample_freq']]

            with st.form("forecasting_form"):
                st.info("Performance Tip: For faster runs, deselect computationally intensive models like `auto_arima` or `dl_moe`.")
                col1, col2, col3 = st.columns(3)
                n_periods = col1.number_input(f"Forecast Horizon ({freq_name}s)", 1, 100, 12, 1)

                # <-- MODIFICATION: Added 'arima' and 'sarimax' -->
                available_models = ['auto_arima', 'prophet', 'holt_winters', 'exponential_smoothing', 'arima', 'sarimax']
                if tf: available_models.append('dl_moe')
                if lgb: available_models.append('lightgbm')

                models_to_try_default = available_models
                # --- FIX: Check st.session_state correctly ---
                if st.session_state.get('exog_df') is not None:
                    # <-- MODIFICATION: Added 'sarimax' to exog list, updated info message -->
                    models_with_exog = ['auto_arima', 'prophet', 'lightgbm', 'sarimax']
                    if 'dl_moe' in available_models: models_with_exog.append('dl_moe')
                    models_to_try_default = models_with_exog
                    st.info("Models without exogenous support (e.g., Holt-Winters, ARIMA) are disabled.")
                else:
                    st.info("Running in univariate mode (no external factors provided).")


                models_to_try = col2.multiselect("Models to Compare", available_models, default=models_to_try_default)
                error_threshold = col3.slider("MAPE Threshold for Error Correction (%)", 0.0, 50.0, 25.0, 0.5)

                use_tsfresh = False
                if extract_features:
                    use_tsfresh = st.checkbox("Use Advanced Feature Engineering (tsfresh)", value=False, help="Slower, but may improve accuracy for ML models like LightGBM.")

                submitted = st.form_submit_button("Run Forecast for All Selected Products", use_container_width=True)

            if submitted:
                if not models_to_try:
                    st.warning("Please select at least one model.")
                else:
                    st.session_state.all_forecast_results = {}
                    # <-- MODIFICATION: Clear what-if scenario on new forecast -->
                    st.session_state.what_if_scenario_rules = []
                    config = st.session_state.config
                    df_main = st.session_state.df

                    progress_bar = st.progress(0)
                    total_groups = len(config['selected_groups'])

                    internal_proxies = []
                    group_cols_list = config.get('group_cols', [])
                    group_col_logic = config.get('group_col_logic')

                    if config.get('use_internal_proxies', False) and group_col_logic:
                        df_proxies = df_main.copy()
                        if len(group_cols_list) > 1:
                            df_proxies[group_col_logic] = df_proxies[group_cols_list].astype(str).agg('_'.join, axis=1)

                        all_group_names = df_proxies[group_col_logic].unique()
                        for name in all_group_names:
                            product_df = df_proxies[df_proxies[group_col_logic] == name]
                            internal_proxies.append((name, product_df))

                    for i, group in enumerate(config['selected_groups']):
                        st.markdown(f"--- \n ### Forecasting for: **{group}**")
                        try:
                            eda = st.session_state.eda_objects[group]

                            date_range_days = (eda.df_eda.index.max() - eda.df_eda.index.min()).days
                            is_this_product_new = date_range_days < config['new_product_threshold']
                            strategy = 'proxy' if is_this_product_new else 'none'

                            proxy_files_data = []
                            if is_this_product_new:
                                proxies_for_this_run = [p for p in internal_proxies if p[0] != group]

                                if config['proxy_files']:
                                    external_proxies = [(f.name, pd.read_csv(f)) for f in config['proxy_files']]
                                    proxies_for_this_run.extend(external_proxies)

                                if not proxies_for_this_run:
                                    st.error(f"'{group}' was identified as a new product, but no proxy products were available (either internal or external). Skipping forecast.")
                                    continue
                                proxy_files_data = proxies_for_this_run

                            start_date_str = eda.df_eda.index.min().strftime('%Y-%m-%d')

                            forecaster = TimeSeriesForecaster(eda, proxy_files_data, start_date_str)

                            final_forecast, best_model_name, best_model_result, result = forecaster.forecast(
                                n_periods=n_periods, models_to_try=models_to_try,
                                error_threshold=error_threshold, new_product_strategy=strategy,
                                use_tsfresh=use_tsfresh
                            )

                            st.session_state.all_forecast_results[group] = {
                                'forecaster': forecaster, 'final_forecast': final_forecast, 'best_model_name': best_model_name,
                                'best_model_result': best_model_result, 'result': result
                            }
                        except Exception as e:
                            st.error(f"An error occurred during forecasting for {group}: {e}")
                            st.exception(e)

                        progress_bar.progress((i + 1) / total_groups)

                    st.session_state.ran_forecast = True
                    st.success("All forecasts completed!")


            if st.session_state.ran_forecast:
                st.markdown("---"); st.header("Overall Performance Summary")
                st.info("This table shows the performance of all models that were part of the competition, evaluated on a test set held back from training.")
                st.session_state.report_data = {}

                all_perf_dfs = []
                for group, data in st.session_state.all_forecast_results.items():
                    perf_df = pd.DataFrame(data['forecaster'].last_run_details)
                    perf_df.insert(0, 'Group', group)
                    all_perf_dfs.append(perf_df)

                if all_perf_dfs:
                    summary_df = pd.concat(all_perf_dfs, ignore_index=True)
                    st.dataframe(summary_df)

                with st.expander("Common Warnings Explained"):
                    st.markdown("""
                    - **`[LightGBM] [Warning] No further splits with positive gain...`**: This is a common and usually harmless message from the LightGBM model. It means that for some of the decision trees it was building, it reached a point where it couldn't find any more ways to improve by splitting the data. This often happens on small datasets or when the model has already captured the main patterns. It is not an error.
                    - **`Could not generate confidence intervals...`**: This message appears for models like Holt-Winters if you are using an older version of the `statsmodels` library. The app safely falls back to providing just the point forecast without confidence bands.
                    """)

                st.markdown("---"); st.header("Detailed Forecast Results")

                forecasted_products = list(st.session_state.all_forecast_results.keys())

                if forecasted_products:
                    default_selection = forecasted_products[0:1] if forecasted_products else []

                    st.session_state.groups_to_display_for_what_if = st.multiselect(
                        "Select group(s) to view detailed forecasts",
                        forecasted_products,
                        default=default_selection
                    )

                    for group in st.session_state.groups_to_display_for_what_if:
                        data = st.session_state.all_forecast_results[group]

                        with st.expander(f"View Results for: **{group}**", expanded=True):
                            forecaster = data['forecaster']
                            final_forecast = data['final_forecast']
                            best_model_result = data['best_model_result']
                            config = st.session_state.config

                            # --- NEW: Narrative Summary ---
                            narrative = generate_narrative_summary(data, config)
                            st.markdown(narrative)

                            group_report = {
                                'perf_df': pd.DataFrame(data['forecaster'].last_run_details),
                                'inventory_val_col': config['inventory_val_col'],
                                'narrative_summary': narrative.replace("**", "") # Remove markdown for PDF
                            }

                            st.subheader(f"Forecast Plot for {group}")
                            st.info("Hover over the forecast line to see the attribution for each data point.")

                            attribution_df = generate_attribution_df(data, config)
                            plot_df = pd.concat([
                                forecaster.eda.df_eda[forecaster.eda.sales_col].rename('Actual'),
                                final_forecast.rename('Forecast'),
                                attribution_df
                            ], axis=1)

                            fig = go.Figure()

                            # --- NEW: Add confidence interval plot ---
                            if best_model_result.get('forecast_ci') is not None:
                                ci_df = best_model_result['forecast_ci']
                                fig.add_trace(go.Scatter(
                                    x=ci_df.index, y=ci_df['upper'], mode='lines',
                                    line=dict(color='rgba(0,100,80,0.2)'), name='Upper CI', showlegend=False
                                ))
                                fig.add_trace(go.Scatter(
                                    x=ci_df.index, y=ci_df['lower'], mode='lines',
                                    fill='tonexty', fillcolor='rgba(0,100,80,0.2)',
                                    line=dict(color='rgba(0,100,80,0.2)'), name='Confidence Interval'
                                ))

                            fig.add_trace(go.Scatter(
                                x=plot_df.index, y=plot_df['Actual'], mode='lines', name='Actual Data'
                            ))

                            attribution_pct_cols = [col for col in plot_df.columns if col.endswith('_pct')]
                            custom_data = plot_df[attribution_pct_cols].fillna(0)

                            hover_header = "<b>%{x|%Y-%m-%d}</b><br>Forecast: %{y:,.2f}<br><br><b>Attribution:</b><br>"
                            hover_lines = []
                            for i, col_name in enumerate(attribution_pct_cols):
                                display_name = col_name.replace('_pct', '').replace('_', ' ').title()
                                hover_lines.append(f"{display_name}: %{{customdata[{i}]:.1f}}%")

                            hover_template = hover_header + "<br>".join(hover_lines) + "<extra></extra>"

                            fig.add_trace(go.Scatter(
                                x=plot_df.index,
                                y=plot_df['Forecast'],
                                mode='lines',
                                name=data['best_model_name'],
                                line=dict(dash='dash', color=DHISHAAI_ORANGE),
                                customdata=custom_data,
                                hovertemplate=hover_template
                            ))

                            if data['result']['Error Correction Applied']:
                                fig.add_trace(go.Scatter(
                                    x=data['best_model_result']['forecast'].index,
                                    y=data['best_model_result']['forecast'],
                                    mode='lines',
                                    name=f"Base {data['best_model_result']['model_name'].upper()} Forecast",
                                    line=dict(dash='dot')
                                ))

                            fig.update_layout(title=f'Forecast for {group} with Dynamic Attribution', legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1))
                            st.plotly_chart(fig, use_container_width=True)

                            if data['result']['Error Correction Applied']:
                                st.info(
                                    """
                                    **Understanding the Forecast Lines:**
                                    - **Base Forecast** (dotted line): This is the initial forecast produced by the base model (e.g., Prophet).
                                    - **Corrected Forecast** (dashed line): This is the final, improved forecast. It's created by using an advanced XGBoost model to predict the errors of the *Base Forecast* and then adding those corrections back.
                                    """
                                )

                            freq_format_map = {'D': '%Y-%m-%d', 'W': '%Y-%m-%d', 'M': '%b %Y', 'Q': '%Y-Q%q', 'Y': '%Y'}
                            tick_format = freq_format_map.get(config['resample_freq'], '%Y-%m-%d')
                            fig.update_xaxes(tickformat=tick_format)

                            try:
                                fig.update_layout(template="plotly_white")
                                group_report['forecast_plot'] = fig.to_image(format="png", scale=2)
                            except Exception as e:
                                group_report['forecast_plot'] = None
                                st.error(f"Failed to generate plot image. Error: {e}")
                                st.warning("This may be due to a version conflict. Try running 'pip install --upgrade --force-reinstall kaleido plotly' in your terminal.")

                            st.subheader("Forecast Values")
                            st.dataframe(final_forecast.to_frame(name='Forecasted Values'))

                            if st.session_state.inventory_df is not None:
                                inv_df_full = st.session_state.inventory_df
                                group_cols = config.get('group_cols', [])
                                group_col_for_logic = config.get('group_col_logic')
                                group_inv_df = None

                                if group_col_for_logic:
                                    if all(col in inv_df_full.columns for col in group_cols):
                                        inv_df_processed = inv_df_full.copy()
                                        if len(group_cols) > 1:
                                            inv_df_processed[group_col_for_logic] = inv_df_processed[group_cols].astype(str).agg('_'.join, axis=1)

                                        group_inv_df = inv_df_processed[inv_df_processed[group_col_for_logic] == group].copy()
                                    else:
                                        group_inv_df = inv_df_full.copy()
                                        st.warning(f"Not all grouping columns ({', '.join(group_cols)}) found in inventory data. Using unfiltered inventory for '{group}'.")
                                else:
                                    group_inv_df = inv_df_full.copy()

                                if group_inv_df is not None and not group_inv_df.empty:
                                    group_inv_df[config['inventory_date_col']] = pd.to_datetime(group_inv_df[config['inventory_date_col']])
                                    group_inv_df = group_inv_df.set_index(config['inventory_date_col']).sort_index()
                                    group_inv_df_resampled = group_inv_df.resample(config['resample_freq']).last().ffill()

                                    forecast_df = final_forecast.to_frame(name='Forecasted Values')
                                    analysis_df = perform_demand_gap_analysis(forecast_df, group_inv_df_resampled, config['inventory_val_col'])

                                    data['group_inv_df_resampled'] = group_inv_df_resampled
                                    data['analysis_df'] = analysis_df
                                    group_report['analysis_df'] = analysis_df

                                    gap_fig = make_subplots(rows=2, cols=1, shared_xaxes=True, subplot_titles=("Forecast vs. Inventory", "Demand Gap (Forecast - Inventory)"), vertical_spacing=0.1)
                                    gap_fig.add_trace(go.Scatter(x=analysis_df.index, y=analysis_df['forecast'], name='Forecasted Demand', mode='lines'), row=1, col=1)
                                    gap_fig.add_trace(go.Scatter(x=analysis_df.index, y=analysis_df[config['inventory_val_col']], name='On-Hand Inventory', mode='lines', line=dict(dash='dot')), row=1, col=1)
                                    colors = ['red' if x > 0 else 'blue' for x in analysis_df['demand_gap']]
                                    gap_fig.add_trace(go.Bar(x=analysis_df.index, y=analysis_df['demand_gap'], name='Demand Gap', marker_color=colors), row=2, col=1)
                                    gap_fig.update_layout(height=600, title_text=f'Demand Gap Analysis for {group}', legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1))

                                    gap_fig.update_xaxes(tickformat=tick_format)
                                    try:
                                        gap_fig.update_layout(template="plotly_white")
                                        group_report['inventory_plot'] = gap_fig.to_image(format="png", scale=2)
                                    except Exception: group_report['inventory_plot'] = None

                                    stockout_text, surplus_text = generate_inventory_insights_text(analysis_df)
                                    group_report['stockout_text'] = stockout_text
                                    group_report['surplus_text'] = surplus_text

                            st.subheader("Forecast Error Explainability")
                            if forecaster.last_error_model and hasattr(forecaster.last_error_model, 'feature_importances_'):
                                importances = forecaster.last_error_model.feature_importances_
                                feature_importance_df = pd.DataFrame({'feature': forecaster.last_X_train_columns, 'importance': importances}).sort_values('importance', ascending=False).head(15)
                                fig_importance = px.bar(feature_importance_df, x='importance', y='feature', orientation='h', title=f'Top Features for Predicting Forecast Error for {group}')
                                st.plotly_chart(fig_importance, use_container_width=True)
                            else:
                                st.info("Explainability is available for forecasts where XGBoost error correction was applied.")

                            st.session_state.report_data[group] = group_report

                # --- NEW FORECAST EXPORT CENTER ---
                st.markdown("---"); st.header("Forecast Export Center")
                st.info("Download your forecast data as a CSV or generate a comprehensive PDF report of the entire analysis for all forecasted products.")

                all_forecasts_list = []
                for group, data in st.session_state.all_forecast_results.items():
                    df = data['final_forecast'].to_frame(name='forecasted_value')

                    if data['best_model_result'].get('forecast_ci') is not None:
                        df = df.join(data['best_model_result']['forecast_ci'])

                    df['group'] = group
                    all_forecasts_list.append(df)

                if all_forecasts_list:
                    final_csv_df = pd.concat(all_forecasts_list).reset_index().rename(columns={'index':'date'})
                    csv_data = final_csv_df.to_csv(index=False).encode('utf-8')
                    pdf_bytes = generate_pdf_report(st.session_state.report_data, st.session_state.config)

                    col1, col2 = st.columns(2)
                    with col1:
                        st.download_button(
                            label="Download Forecast Data as CSV",
                            data=csv_data,
                            file_name="demand_forecast.csv",
                            mime="text/csv",
                            use_container_width=True
                        )
                    with col2:
                        if pdf_bytes:
                            st.download_button(
                                label="Download Forecast Report as PDF",
                                data=pdf_bytes,
                                file_name="demand_forecast_report.pdf",
                                mime="application/pdf",
                                use_container_width=True
                            )
                        else:
                            st.warning("PDF generation failed. Please check library installations.")

        with tab3:
            st.header("Causal Explainability using DoWhy")
            st.info("""
            This section uses Causal Inference to move beyond correlation and understand the **cause-and-effect** relationships in your data.
            Select a task below to begin your analysis.
            """)

            if not CausalModel or not graphviz:
                st.error("Please install 'dowhy' and 'graphviz' to use this feature: `pip install dowhy graphviz`")
            else:
                causal_groups = st.session_state.config['selected_groups']
                if len(causal_groups) > 1:
                    group_for_causal = st.selectbox("Select a group for Causal Analysis", causal_groups, key="causal_group_select")
                else:
                    group_for_causal = causal_groups[0]

                # Reset causal model if group changes
                if st.session_state.causal_group != group_for_causal:
                    st.session_state.causal_model = None
                    st.session_state.causal_estimate = None
                    st.session_state.causal_refutation = None
                    st.session_state.causal_variables = {}
                    st.session_state.causal_group = group_for_causal
                    st.session_state.single_causal_estimate_obj = None # <-- Reset this too

                st.markdown(f"#### Analyzing Causal Effects for: **{group_for_causal}**")

                try:
                    eda_obj = st.session_state.eda_objects[group_for_causal]
                    features_df = eda_obj._engineer_features()
                    features_df.rename(columns={'sales': eda_obj.sales_col}, inplace=True)
                    outcome_variable = eda_obj.sales_col
                    potential_features = [col for col in features_df.columns if col not in ['date', outcome_variable]]

                    if not potential_features:
                        st.warning("No feature columns available to analyze for causal effects.")
                    else:
                        causal_task = st.selectbox(
                            "Select a Causal Task",
                            [
                                "Effect Estimation (What is the impact of X on Y?)",
                                "What-if Analysis (Counterfactuals)",
                                "Root Cause Analysis (Find Key Drivers)"
                            ]
                        )

                        if "Effect Estimation" in causal_task:
                            st.markdown("##### 1. Define Your Causal Question")
                            # <-- MODIFICATION: Changed from selectbox to multiselect -->
                            treatment_variables = st.multiselect(
                                "I want to understand the effect of... (Treatment/s)",
                                options=potential_features,
                                help="Select one or more variables you imagine intervening on (the 'causes').",
                                key="ate_treatments"
                            )
                            st.write(f"...on **{outcome_variable}** (Outcome).")
                            # <-- MODIFICATION: Updated potential_confounders logic -->
                            potential_confounders = [col for col in potential_features if col not in treatment_variables]
                            confounder_variables = st.multiselect(
                                "While controlling for... (Common Causes / Confounders)",
                                options=potential_confounders,
                                help="Select variables that you believe might influence BOTH the treatment(s) and the outcome.",
                                key="ate_confounders"
                            )

                            st.markdown("##### 2. Assumed Causal Graph")
                            st.caption("This graph represents your assumptions. Arrows indicate a causal relationship.")
                            # <-- MODIFICATION: Check if treatment_variables is not empty -->
                            if treatment_variables:
                                graph_dot = build_causal_graph(treatment_variables, outcome_variable, confounder_variables)
                                st.graphviz_chart(graph_dot)

                                # <-- MODIFICATION: Replaced button logic with multi-treatment loop -->
                                if st.button("Run Causal Analysis", use_container_width=True, key="run_ate"):
                                    with st.spinner("Running causal analysis for each treatment..."):
                                        st.session_state.causal_model = None # Reset single model
                                        st.session_state.causal_estimate = None # Reset
                                        st.session_state.single_causal_estimate_obj = None # Reset

                                        all_estimates = []
                                        all_refutations_summary = []

                                        for treatment in treatment_variables:
                                            try:
                                                model = CausalModel(
                                                    data=features_df,
                                                    treatment=treatment,
                                                    outcome=outcome_variable,
                                                    common_causes=confounder_variables
                                                )
                                                identified_estimand = model.identify_effect(proceed_when_unidentifiable=True)
                                                estimate = model.estimate_effect(
                                                    identified_estimand,
                                                    method_name="backdoor.linear_regression"
                                                )
                                                refute_result = model.refute_estimate(
                                                    identified_estimand, estimate, method_name="random_common_cause"
                                                )
                                                all_estimates.append({'Treatment': treatment, 'Causal Estimate': estimate.value})
                                                all_refutations_summary.append({'Treatment': treatment, 'Refutation Summary': str(refute_result)})

                                                # If only one treatment was selected, store its model for counterfactuals
                                                if len(treatment_variables) == 1:
                                                    st.session_state.causal_model = model
                                                    st.session_state.single_causal_estimate_obj = estimate

                                            except Exception as e:
                                                st.warning(f"Could not run causal analysis for '{treatment}': {e}")
                                                all_estimates.append({'Treatment': treatment, 'Causal Estimate': np.nan})
                                                all_refutations_summary.append({'Treatment': treatment, 'Refutation Summary': 'Error'})


                                        st.session_state.causal_estimate = pd.DataFrame(all_estimates)
                                        st.session_state.causal_refutation = pd.DataFrame(all_refutations_summary)
                                        st.session_state.causal_variables = {
                                            'treatments': treatment_variables, # Note: plural 'treatments'
                                            'outcome': outcome_variable,
                                            'confounders': confounder_variables
                                        }

                            # <-- MODIFICATION: Replaced results display with DataFrame/expander logic -->
                            if 'causal_estimate' in st.session_state and st.session_state.causal_estimate is not None:
                                st.subheader("Causal Effect Estimation Results")
                                st.info(f"The table below shows the estimated average causal effect on **{outcome_variable}** for a one-unit increase in each treatment variable.")
                                st.dataframe(st.session_state.causal_estimate.style.format({'Causal Estimate': '{:,.4f}'}))

                                st.subheader("Robustness Checks")
                                st.info("A robustness check adds a random common cause to see if the estimated effect changes significantly. A high p-value (> 0.05) suggests the estimate is robust.")
                                if 'causal_refutation' in st.session_state and st.session_state.causal_refutation is not None:
                                    for _, row in st.session_state.causal_refutation.iterrows():
                                        with st.expander(f"Refutation for **{row['Treatment']}**"):
                                            st.text(row['Refutation Summary'])

                        elif "What-if Analysis" in causal_task:
                            # <-- MODIFICATION: Updated checks for single-treatment model -->
                            if not st.session_state.get('causal_model'):
                                st.warning("Please run a single-treatment 'Effect Estimation' analysis first to build the required causal model for this feature.")
                            else:
                                st.markdown("##### Perform a What-if (Counterfactual) Analysis")
                                st.info("This analysis uses the previously built causal model to estimate outcomes under hypothetical scenarios.")

                                treatment = st.session_state.causal_variables['treatments'][0]
                                outcome = st.session_state.causal_variables['outcome']
                                confounders = st.session_state.causal_variables['confounders']
                                estimate = st.session_state.single_causal_estimate_obj # Use the saved single-estimate object

                                st.markdown("**1. Select a data point to analyze**")
                                idx = st.slider("Select data point index", 0, len(features_df)-1, 0)
                                selected_data = features_df.iloc[[idx]]
                                st.write("Original Data Point:")
                                st.dataframe(selected_data)

                                original_treatment_val = selected_data[treatment].iloc[0]

                                st.markdown("**2. Set the hypothetical value**")
                                counterfactual_val = st.number_input(
                                    f"What if '{treatment}' had been...",
                                    value=float(original_treatment_val)
                                )

                                if st.button("Estimate Counterfactual Outcome"):
                                    with st.spinner("Calculating..."):
                                        # --- MODIFICATION START: Fix for counterfactual prediction KeyError ---
                                        import statsmodels.api as sm

                                        linear_model = estimate.estimator.model
                                        counterfactual_data_point = selected_data.copy()
                                        counterfactual_data_point[treatment] = counterfactual_val

                                        predictor_cols = [treatment] + confounders
                                        X_counterfactual_df = counterfactual_data_point[predictor_cols]

                                        # Get feature names the model expects (excluding intercept)
                                        model_feature_names = [name for name in linear_model.model.exog_names if name != 'const']

                                        if len(predictor_cols) == len(model_feature_names):
                                            # Create a map from original names to model's internal names and rename
                                            rename_map = dict(zip(predictor_cols, model_feature_names))
                                            X_renamed = X_counterfactual_df.rename(columns=rename_map)

                                            # Add the constant and align columns for prediction
                                            X_with_constant = sm.add_constant(X_renamed, has_constant='add')
                                            model_exog_names = linear_model.model.exog_names
                                            X_aligned = X_with_constant[model_exog_names]

                                            counterfactual_outcome = linear_model.predict(X_aligned)
                                            original_outcome = selected_data[outcome].iloc[0]

                                            st.subheader("Counterfactual Result")
                                            col1, col2, col3 = st.columns(3)
                                            col1.metric("Original Outcome", f"{original_outcome:,.2f}")
                                            col2.metric("Counterfactual Outcome", f"{counterfactual_outcome[0]:,.2f}")
                                            col3.metric("Estimated Change", f"{counterfactual_outcome[0] - original_outcome:,.2f}", delta_color="inverse")

                                            st.info(f"If **{treatment}** had been **{counterfactual_val:,.2f}** (instead of {original_treatment_val:,.2f}), the estimated **{outcome}** would have been **{counterfactual_outcome[0]:,.2f}** (instead of {original_outcome:,.2f}).")
                                        else:
                                            st.error("A mismatch occurred between the number of features and the model's parameters. This can happen if feature names are interpreted incorrectly.")
                                        # --- MODIFICATION END ---

                        elif "Root Cause Analysis" in causal_task:
                            st.markdown("##### Find the Strongest Causal Drivers of the Outcome")
                            st.info(f"This analysis will treat each available feature as a potential cause and estimate its average causal effect on **{outcome_variable}**. This helps identify which factors have the most influence.")

                            use_all_confounders = st.checkbox("Control for all other variables in each test", value=True, help="When testing X's effect, all other features will be used as confounders. Uncheck to run simple bivariate causal models.")

                            if st.button("Find Key Drivers", use_container_width=True):

                                @st.cache_data
                                def find_all_drivers(_features_df, _potential_features, _outcome, _use_all_confounders):
                                    results = []
                                    progress_bar = st.progress(0, text="Analyzing features...")
                                    for i, treatment in enumerate(_potential_features):
                                        if _use_all_confounders:
                                            confounders = [f for f in _potential_features if f != treatment]
                                        else:
                                            confounders = []
                                        try:
                                            model = CausalModel(data=_features_df, treatment=treatment, outcome=_outcome, common_causes=confounders)
                                            estimand = model.identify_effect(proceed_when_unidentifiable=True)
                                            estimate = model.estimate_effect(estimand, method_name="backdoor.linear_regression")
                                            results.append({"Feature (Cause)": treatment, "Estimated Causal Effect": estimate.value})
                                        except Exception:
                                            results.append({"Feature (Cause)": treatment, "Estimated Causal Effect": np.nan})
                                        progress_bar.progress((i+1)/len(_potential_features), text=f"Analyzing {treatment}...")
                                    progress_bar.empty()
                                    return pd.DataFrame(results).dropna()

                                with st.spinner("Analyzing all features... This may take some time."):
                                    results_df = find_all_drivers(features_df, potential_features, outcome_variable, use_all_confounders)

                                    st.subheader("Causal Driver Analysis Results")
                                    if not results_df.empty:
                                        results_df['abs_effect'] = results_df['Estimated Causal Effect'].abs()
                                        sorted_results = results_df.sort_values(by="abs_effect", ascending=False).drop(columns=['abs_effect'])

                                        st.dataframe(sorted_results.style.format({'Estimated Causal Effect': '{:,.4f}'}))

                                        fig = px.bar(
                                            sorted_results.head(15),
                                            x="Estimated Causal Effect", y="Feature (Cause)", orientation='h',
                                            title=f"Top 15 Causal Drivers of {outcome_variable}",
                                            color="Estimated Causal Effect", color_continuous_scale=px.colors.diverging.Picnic
                                        )
                                        fig.update_layout(yaxis={'categoryorder':'total ascending'})
                                        st.plotly_chart(fig, use_container_width=True)
                                    else:
                                        st.warning("Could not compute causal effects for the features.")

                except Exception as e:
                    st.error(f"An error occurred during causal analysis for '{group_for_causal}': {e}")
                    st.exception(e)

        # <-- MODIFICATION: Added new 'What-If Scenarios' tab -->
        with tab4:
            st.header("🔬 What-If Scenario Analysis")

            if not st.session_state.ran_forecast:
                st.info("Please run a forecast in the 'Forecast & Performance' tab to enable What-If Scenario Analysis.")
            else:
                 # --- FIX: Check if forecaster.exog_forecast exists, not session_state.exog_df ---
                forecaster_has_exog = False
                if st.session_state.all_forecast_results:
                     # Check the forecaster object for the first group (assuming structure is consistent)
                     first_group = list(st.session_state.all_forecast_results.keys())[0]
                     if 'forecaster' in st.session_state.all_forecast_results[first_group]:
                         forecaster_obj = st.session_state.all_forecast_results[first_group]['forecaster']
                         if forecaster_obj.exog_forecast is not None:
                             forecaster_has_exog = True

                if not forecaster_has_exog:
                    st.warning("What-if analysis requires exogenous features. These can come from an 'External Factors' file OR be generated internally by the EDA process (e.g., lags, date parts). Ensure features are being generated.")
                else:
                    forecasted_products = list(st.session_state.all_forecast_results.keys())
                    what_if_group = st.selectbox(
                        "Select group to apply scenario",
                        options=forecasted_products,
                        key="what_if_group_select"
                    )
                    if what_if_group:
                        data = st.session_state.all_forecast_results[what_if_group]
                        forecaster = data['forecaster']
                        best_model_result = data['best_model_result']
                        model_name = best_model_result['model_name']

                        st.markdown("#### 1. Build Your Scenario")
                        st.markdown("Define one or more changes to your features and add them to the scenario.")

                        exog_features = forecaster.exog_forecast.columns.tolist()

                        with st.form("what_if_rule_form"):
                            col1, col2, col3 = st.columns(3)
                            feature_to_change = col1.selectbox("Select Feature to Change", exog_features)
                            change_type = col2.selectbox("Type of Change", ["Percentage Change", "Constant Change", "Set to New Value"])

                            if change_type == "Percentage Change":
                                change_value = col3.number_input("Enter Percentage (%)", value=10.0, step=1.0)
                            elif change_type == "Constant Change":
                                change_value = col3.number_input("Enter Value to Add/Subtract", value=100.0, step=10.0)
                            else: # Set to New Value
                                change_value = col3.number_input("Enter New Value to Set", value=1.0, step=1.0)

                            add_rule_button = st.form_submit_button("Add Change to Scenario")

                            if add_rule_button:
                                st.session_state.what_if_scenario_rules.append({
                                    "Feature": feature_to_change,
                                    "Type of Change": change_type,
                                    "Value": change_value
                                })
                                st.rerun()

                        st.markdown("#### 2. Current Scenario")
                        if not st.session_state.what_if_scenario_rules:
                            st.info("No changes added to the scenario yet.")
                        else:
                            st.dataframe(pd.DataFrame(st.session_state.what_if_scenario_rules))
                            if st.button("Clear Scenario"):
                                st.session_state.what_if_scenario_rules = []
                                st.rerun()

                        st.markdown("#### 3. Run Simulation")
                        min_date = data['final_forecast'].index.min()
                        max_date = data['final_forecast'].index.max()

                        col1, col2 = st.columns(2)
                        start_date = col1.date_input("Scenario Start Date", value=min_date, min_value=min_date, max_value=max_date)
                        end_date = col2.date_input("Scenario End Date", value=max_date, min_value=min_date, max_value=max_date)

                        use_causal_effect = False
                        causal_model_available_and_relevant = False

                        if len(st.session_state.what_if_scenario_rules) == 1:
                            rule = st.session_state.what_if_scenario_rules[0]
                            if 'causal_estimate' in st.session_state and isinstance(st.session_state.causal_estimate, pd.DataFrame):
                                # Check if a single-treatment model was run
                                if 'single_causal_estimate_obj' in st.session_state and st.session_state.single_causal_estimate_obj:
                                    single_treatment_run = st.session_state.causal_variables.get('treatments', [])
                                    if len(single_treatment_run) == 1:
                                        if (st.session_state.get('causal_group') == what_if_group and
                                            single_treatment_run[0] == rule['Feature']):
                                            causal_model_available_and_relevant = True

                        if causal_model_available_and_relevant:
                            use_causal_effect = st.checkbox(
                                "✅ Apply Causal Estimate (from DoWhy)",
                                value=True,
                                help=f"Applies the historically-derived causal effect of '{rule['Feature']}' to adjust the forecast. This is only available for single-change scenarios."
                            )
                        else:
                            st.caption(f"ℹ️ To enable causal what-if, build a scenario with a single rule and ensure a single-treatment 'Effect Estimation' model has been run for that feature in the 'Causal Explainability' tab.")


                        if st.button("Run What-If Scenario", use_container_width=True):
                            if not st.session_state.what_if_scenario_rules:
                                st.warning("Please add at least one change to the scenario before running.")

                            elif use_causal_effect and causal_model_available_and_relevant:
                                st.info("Applying Causal Adjustment to Baseline Forecast...")
                                with st.spinner("Calculating causal impact..."):
                                    rule = st.session_state.what_if_scenario_rules[0]
                                    baseline_forecast = data['final_forecast']
                                    # Get the ATE from the DataFrame
                                    ate = st.session_state.causal_estimate[st.session_state.causal_estimate['Treatment'] == rule['Feature']]['Causal Estimate'].iloc[0]

                                    original_exog = forecaster.exog_forecast.copy()
                                    date_mask = (original_exog.index >= pd.to_datetime(start_date)) & (original_exog.index <= pd.to_datetime(end_date))

                                    if rule['Type of Change'] == "Percentage Change":
                                        change_in_feature = original_exog.loc[date_mask, rule['Feature']] * (rule['Value'] / 100)
                                    elif rule['Type of Change'] == "Constant Change":
                                        change_in_feature = rule['Value']
                                    else:
                                        change_in_feature = rule['Value'] - original_exog.loc[date_mask, rule['Feature']]

                                    sales_impact = change_in_feature * ate
                                    what_if_forecast = baseline_forecast.copy()
                                    what_if_forecast.loc[date_mask] = what_if_forecast.loc[date_mask] + sales_impact

                                    st.subheader("What-If Scenario Results")
                                    total_original = data['final_forecast'].sum()
                                    total_what_if = what_if_forecast.sum()
                                    total_impact = total_what_if - total_original
                                    pct_change = (total_impact / total_original) * 100 if total_original != 0 else 0

                                    c1, c2, c3 = st.columns(3)
                                    c1.metric("Baseline Forecast Total", f"{total_original:,.0f}")
                                    c2.metric("What-If Forecast Total", f"{total_what_if:,.0f}", delta=f"{total_impact:,.0f}")
                                    c3.metric("Percentage Change", f"{pct_change:.2f}%")

                                    fig_what_if = go.Figure()
                                    fig_what_if.add_trace(go.Scatter(x=data['final_forecast'].index, y=data['final_forecast'], name="Original Forecast", mode='lines', line=dict(dash='dot')))
                                    fig_what_if.add_trace(go.Scatter(x=what_if_forecast.index, y=what_if_forecast, name="Causally-Adjusted Scenario", mode='lines'))
                                    fig_what_if.update_layout(title=f"Causal What-If Scenario vs. Original Forecast for {what_if_group}", legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1))
                                    st.plotly_chart(fig_what_if, use_container_width=True)

                            else:
                                # <-- MODIFICATION: Changed model check -->
                                if model_name not in ['prophet', 'auto_arima', 'sarimax']:
                                    st.warning(f"**What-If Analysis Not Supported for '{model_name.upper()}'**")
                                    st.info(f"The best model found for this group was {model_name.upper()}. To use this feature, please re-run the forecast and select only 'AutoARIMA', 'SARIMAX', or 'Prophet' in the 'Models to Compare' section.")
                                else:
                                    st.info("Running full model re-forecast...")
                                    scenario_exog = forecaster.exog_forecast.copy()
                                    date_mask = (scenario_exog.index >= pd.to_datetime(start_date)) & (scenario_exog.index <= pd.to_datetime(end_date))

                                    for rule in st.session_state.what_if_scenario_rules:
                                        feature_to_change = rule['Feature']
                                        change_type = rule['Type of Change']
                                        change_value = rule['Value']

                                        if change_type == "Percentage Change":
                                            scenario_exog.loc[date_mask, feature_to_change] *= (1 + change_value / 100)
                                        elif change_type == "Constant Change":
                                            scenario_exog.loc[date_mask, feature_to_change] += change_value
                                        else:
                                            scenario_exog.loc[date_mask, feature_to_change] = change_value

                                    base_model_obj = best_model_result.get('model_object')
                                    new_base_forecast = None

                                    if model_name == 'prophet' and base_model_obj:
                                        future_df = base_model_obj.make_future_dataframe(periods=len(forecaster.exog_forecast), freq=config['resample_freq'])
                                        future_df = future_df.merge(scenario_exog, left_on='ds', right_index=True, how='left').ffill().bfill()
                                        new_base_forecast_full = base_model_obj.predict(future_df)
                                        new_base_forecast = new_base_forecast_full['yhat'][-len(forecaster.exog_forecast):].values
                                        new_base_forecast = pd.Series(new_base_forecast, index=forecaster.exog_forecast.index)

                                    # <-- MODIFICATION: Changed to 'auto_arima' and .predict() -->
                                    elif model_name == 'auto_arima' and base_model_obj:
                                        new_base_forecast = base_model_obj.predict(n_periods=len(scenario_exog), X=scenario_exog)
                                        # Ensure the index is correct
                                        new_base_forecast.index = scenario_exog.index

                                    # <-- MODIFICATION: Added 'sarimax' -->
                                    elif model_name == 'sarimax' and base_model_obj:
                                        new_base_forecast = base_model_obj.forecast(steps=len(scenario_exog), exog=scenario_exog)


                                    if new_base_forecast is not None:
                                        what_if_forecast = new_base_forecast
                                        if data['result']['Error Correction Applied'] and forecaster.last_error_model:
                                            # Align columns for prediction
                                            scenario_exog_aligned = scenario_exog.reindex(columns=forecaster.last_X_train_columns, fill_value=0)
                                            predicted_errors = forecaster.last_error_model.predict(scenario_exog_aligned.values)
                                            what_if_forecast += predicted_errors

                                        st.subheader("What-If Scenario Results")
                                        total_original = data['final_forecast'].sum()
                                        total_what_if = what_if_forecast.sum()
                                        total_impact = total_what_if - total_original
                                        pct_change = (total_impact / total_original) * 100 if total_original != 0 else 0

                                        c1, c2, c3 = st.columns(3)
                                        c1.metric("Baseline Forecast Total", f"{total_original:,.0f}")
                                        c2.metric("What-If Forecast Total", f"{total_what_if:,.0f}", delta=f"{total_impact:,.0f}")
                                        c3.metric("Percentage Change", f"{pct_change:.2f}%")

                                        fig_what_if = go.Figure()
                                        fig_what_if.add_trace(go.Scatter(x=data['final_forecast'].index, y=data['final_forecast'], name="Original Forecast", mode='lines', line=dict(dash='dot')))
                                        fig_what_if.add_trace(go.Scatter(x=what_if_forecast.index, y=what_if_forecast, name="Multi-Feature Scenario Forecast", mode='lines'))
                                        fig_what_if.update_layout(title=f"Multi-Feature Scenario vs. Original Forecast for {what_if_group}", legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1))
                                        st.plotly_chart(fig_what_if, use_container_width=True)
                                    else:
                                         st.error(f"Could not generate a What-if forecast for an unknown reason, even though the model ('{model_name.upper()}') is supported.")


if __name__ == '__main__':
    main()